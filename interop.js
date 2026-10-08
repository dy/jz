/**
 * jz/interop — host-side boundary codec.
 *
 * Importable as `jz/interop` without pulling the compiler, parser, or watr —
 * use this to run prebuilt jz wasm from a host that doesn't need to compile.
 * Dependencies contain only host linking, layout, errors and text decoding.
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
import { HEAP, PTR, FIELD, encodePtrHi, decodePtrType, decodePtrAux, ATOM, ATOM_HI, LAYOUT, SYMBOL_MIN, TOMB_NAN, DATA_VIEW_FLAG, DATA_VIEW_AUX, TYPED_ELEM_VIEW_FLAG, ctorFromElemAux, HIDDEN_PROPERTY_SEQ } from './layout.js'
import { ERROR_CODE_HI, ERR_INFO, ERR_CLASS_NAMES } from './err-codes.js'
import { decodeUtf8 } from './utf8.js'

// UTF-8 codecs for Wasm metadata. String values use lossless UTF-16 marshalling.
const TEXT_DEC = { decode: decodeUtf8 }

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

// Every i32 heap address that crosses the wasm boundary — a `$__heap` Global's `.value`,
// or a DataView 32-bit read — comes back through JS as a SIGNED int32 (WebAssembly JS API
// spec: i32 is observable as ToInt32, range -2^31..2^31-1), regardless of what the address
// actually represents (offsets are conceptually unsigned, 0..4GiB). `>>> 0` reinterprets
// the bit pattern back to unsigned. Skipping this is harmless below 2 GiB (same value
// either way) and silently wrong past it — a "negative" address then poisons every
// downstream `+`/comparison, and a DataView write at a negative offset throws RangeError.
const makeJsAllocator = (mem, heapGlobal) => {
  const dv = () => new DataView(mem.buffer)
  const getPtr = heapGlobal ? () => heapGlobal.value >>> 0 : () => dv().getUint32(HEAP.PTR_ADDR, true)
  const setPtr = heapGlobal ? v => { heapGlobal.value = v } : v => dv().setInt32(HEAP.PTR_ADDR, v, true)
  // Rewind target: the global's post-static-init value, else the fixed start.
  let base = heapGlobal ? (heapGlobal.value >>> 0) : HEAP.START
  const alloc = (bytes) => {
    // Align up to 8 without `& ~7` — a JS bitwise op ToInt32-truncates its RESULT too,
    // so `(x + 7) & ~7` would re-introduce the same sign flip past 2 GiB even with a
    // correctly-unsigned `getPtr()`. Plain arithmetic has no such ceiling.
    const ptr = getPtr()
    const aligned = Math.ceil(ptr / 8) * 8
    const next = aligned + bytes
    if (!Number.isSafeInteger(bytes) || bytes < 0 || next >= 2 ** 32)
      throw new RangeError('allocation exceeds the wasm32 heap or has an invalid size')
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
    if (d.getUint32(HEAP.PTR_ADDR, true) < HEAP.START) d.setInt32(HEAP.PTR_ADDR, HEAP.START, true)
  }
  // The heap top and the post-init base: `memory.used` is their distance, and a
  // call that may release its argument copies rewinds the top to a mark.
  return { alloc, reset, initHeapPtr, top: getPtr, setTop: setPtr,
    used: () => getPtr() - base,
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

const sectionReader = (bytes) => {
  const td = TEXT_DEC
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

// NaN-box codec — integer / BigInt based. A box NEVER becomes a JS number: JSC (Safari)
// canonicalizes a NaN payload the instant it materializes as f64 (boundary return,
// Float64Array read, getFloat64), so a box is carried in JS-land as a BigInt (the i64
// bits) and decoded with integer ops. Only genuine (non-NaN) numbers ever touch f64.
const MASK32 = 0xffffffffn
// Reinterpret for GENUINE numbers (and freshly-built boxes leaving JS): `_f64` only ever
// holds a real number here, never a live NaN-box, so there is nothing for JSC to purify.
// The bits cross through one 8-byte cell (a BigInt stored takes its value mod 2^64):
// shifting and masking a BigInt allocates at every step, several per argument.
const _buf = new ArrayBuffer(8), _u32 = new Uint32Array(_buf), _f64 = new Float64Array(_buf), _u64 = new BigUint64Array(_buf)
export const f64ToI64 = (n) => { _f64[0] = n; return _u64[0] }
export const i64ToF64 = (b) => { _u64[0] = b; return _f64[0] }

const hi32 = (b) => { _u64[0] = b; return _u32[1] }
const lo32 = (b) => { _u64[0] = b; return _u32[0] }
// A NaN-box is a sign-0 quiet NaN — high u32 carries jz's 0x7FF8 prefix. The
// mask MUST include the sign bit (0xFFF80000, not 0x7FF80000): a plain host
// BigInt's 64-bit two's-complement sign-extension sets hi32's top 12 prefix
// bits (0x7FF8's own span, bits 30-19) to 1 for any negative value whose
// magnitude keeps them saturated (every -1n..-2^51n verified live) — with
// the sign bit (bit 31, 0x80000000) left out of the mask, isBox(-5n) read
// true, so i64Arg's `!isBox(x)` gate and wrapVal's `isBox(v)` gate both
// treated a raw negative host BigInt as an ALREADY-BUILT box and skipped
// mem.BigInt's allocation entirely. The unboxed bits then reached
// __to_bigint's (module/number.js) tag dispatch inside wasm, whose
// $__ptr_type read a garbage tag off the non-box pattern (not PTR.BIGINT)
// and fell to the "not a box, not a string" 0n default — negative host
// BigInt ingress silently computed from magnitude 0 instead of throwing or
// computing correctly (`f(-5n)` where `f=(v)=>parse(v)+1n` read back `1n`,
// not `-4n`). module/core.js's $__typeof already gates the identical
// distinction correctly (its own `0xFFF0000000000000` mask: "negative-NaN
// bit patterns (sign bit set) don't match NAN_PREFIX so are uniquely
// numeric") — this brings isBox into agreement with that reference. A
// GENUINE box always has sign=0 (ptrBits/encodePtrHi never set bit 63), so
// this tightening never rejects a real box — it only excludes negative bit
// patterns no legitimate box can ever produce.
const BOX_HI = LAYOUT.NAN_PREFIX << 16, BOX_HI_MASK = BOX_HI | 0x80000000
const isBox = (b) => (hi32(b) & BOX_HI_MASK) === BOX_HI
// i64 bits for a wrapVal result (BigInt box, or number → its f64 bits): memory staging + i64 params.
const bits = (v) => typeof v === 'bigint' ? v : f64ToI64(v)

// Reserved atoms (type=ATOM, offset=0): aux 1/2/4/5 → null/undefined/false/true. BigInt boxes.
export const NULL_NAN = BigInt(ATOM_HI[ATOM.NULL]) << 32n
export const UNDEF_NAN = BigInt(ATOM_HI[ATOM.UNDEF]) << 32n
export const FALSE_NAN = BigInt(ATOM_HI[ATOM.FALSE]) << 32n
export const TRUE_NAN = BigInt(ATOM_HI[ATOM.TRUE]) << 32n
// Absent array cells have no own index; present undefined keeps UNDEF_NAN.
const TOMB_BITS = BigInt(TOMB_NAN)

// Semantic JS values enter the tagged lane here. Numbers cannot carry handles;
// canonicalize NaNs before their payload can be mistaken for an atom or pointer.
export const coerce = v => v === null ? NULL_NAN : v === undefined ? UNDEF_NAN : v !== v ? NaN : v

// SSO-encode a string ≤6 ASCII chars to a NaN-box BigInt (no heap needed).
// Mirrors mem.String's SSO branch. Used when marshaling a string into an i64-carrier
// param of a memoryless module (no linear memory, so only self-contained bit encodings
// like SSO can survive the boundary). Non-SSO strings throw clearly rather than silently
// becoming NaN.
const encodeSSO = (s) => {
  let p = 0n
  for (let i = 0; i < s.length; i++) p |= BigInt(s.charCodeAt(i)) << BigInt(i * 7)
  p |= BigInt(s.length) << 42n
  return ptr(4, Number(p >> 32n) | LAYOUT.SSO_BIT, Number(p & 0xFFFFFFFFn))
}

// Accept either the i64 carrier (BigInt, canonical) or a legacy f64 NaN-box (intact on V8 —
// e.g. an adaptI64 result, or user code holding a pre-i64 pointer) — normalize before decode.
const asBits = (p) => typeof p === 'bigint' ? p : f64ToI64(p)
export const ptr = (type, aux, offset) => { _u32[1] = encodePtrHi(type, aux); _u32[0] = offset; return _u64[0] }
export const offset = (p) => lo32(asBits(p))
export const type = (p) => decodePtrType(hi32(asBits(p)))
export const aux = (p) => decodePtrAux(hi32(asBits(p)))

// SSO string decode from i64 bits: 7-bit ASCII, char i at payload bit i*7, len at bits 42-44.
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
  const section = mod && customSection(mod, 'jz:symbols')
  if (section) for (const [key, id] of JSON.parse(TEXT_DEC.decode(section)))
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

// Memory-free decode of an i64-bits boundary value: numbers pass through, a box becomes
// its atom / SSO string. Exactly the forms a *memoryless* module can carry (no linear
// memory → no heap string/array/object). Heap-carrying modules route through `mem.read`.
// `fnOf` reads a closure as a JS function (wrap's reader): a module with no
// heap holds closures too, one that captures nothing needs none.
const decode = (v, fnOf = null, symbols = null) => {
  if (Array.isArray(v)) return v.map(x => decode(x, fnOf, symbols))   // multi-value tuple, each lane an i64-carrier (memoryless)
  if (typeof v === 'number') { if (v === v) return v; v = f64ToI64(v) }  // f64 NaN-box (intact on V8) → bits
  else if (typeof v !== 'bigint') return v     // already-decoded JS value
  if (!isBox(v)) return i64ToF64(v)            // non-NaN bits → number
  if (type(v) === 4 && (aux(v) & LAYOUT.SSO_BIT)) return decodeSSO(v)
  if (type(v) === 10 && fnOf) return fnOf(v)
  if (symbols && type(v) === PTR.ATOM && aux(v) >= SYMBOL_MIN && v !== TOMB_BITS) return symbols.read(v)
  if (offset(v) === 0) {
    if (v === NULL_NAN) return null
    if (v === UNDEF_NAN) return undefined
    if (v === FALSE_NAN) return false
    if (v === TRUE_NAN) return true
  }
  return i64ToF64(v)                            // canonical NaN-number / unknown
}

// Decode a boundary value arriving as i64 bits (BigInt). Heap modules go through mem.read.
const readArgBits = (state, big) => state.mem ? state.mem.read(big) : decode(big)

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
  // flag-carrying kinds: elemId = base code | flag (16 = BigInt,
  // 32 = f16, 64 = clamped). BigInt64/BigUint64 share the compiler's raw
  // two's-complement storage tag; decoding follows JZ's documented signed-i64
  // BigInt contract.
  BigInt64Array: [23, 8, 'getBigInt64', 'setBigInt64'],
  BigUint64Array: [23, 8, 'getBigUint64', 'setBigUint64'],
  Float16Array: [35, 2, 'getFloat16', 'setFloat16'],
  Uint8ClampedArray: [65, 1, 'getUint8', 'setUint8'],
}
// Pre-built lookup by element ID (avoids Object.values on each access)
const ELEM_BY_ID = Object.values(ELEMS)

const _enhanced = new WeakSet()

/**
 * The tables a module declares for the memory it links to, read from its
 * custom sections (the jz:schema writer in compile/index.js): the Error class
 * and the user-class brand by schema id, the field contracts and the property
 * lists by position (entry index === compile-time schema id). A schema entry
 * is { type, payload }: type 0 a null (computed or missing key), type 1 a
 * nested [null, name] (synthetic shape), type 3 a JSON-escaped property name
 * without its quotes, type 2 legacy text.
 */
const NO_TABLES = { errorClasses: new Map(), brands: new Map(), regexes: new Map(), fields: [], schemas: [], views: new Set() }
const moduleTables = (mod) => {
  const errorClasses = new Map(), brands = new Map(), regexes = new Map(), fields = [], schemas = [], views = new Set()
  // the schemas with an object literal's accessor: read through the module's data copy (`__view_data`)
  const viewBytes = customSection(mod, 'jz:views')
  if (viewBytes) {
    const r = sectionReader(viewBytes), n = r.varint()
    for (let j = 0; j < n; j++) views.add(r.varint())
  }
  const errClsBytes = customSection(mod, 'jz:errcls')
  if (errClsBytes) {
    const r = sectionReader(errClsBytes), n = r.varint()
    for (let j = 0; j < n; j++) { const sid = r.varint(); errorClasses.set(sid, r.str(r.varint())) }
  }
  const brandBytes = customSection(mod, 'jz:brand')
  if (brandBytes) {
    const r = sectionReader(brandBytes), n = r.varint()
    for (let j = 0; j < n; j++) { const sid = r.varint(); brands.set(sid, r.str(r.varint())) }
  }
  const regexBytes = customSection(mod, 'jz:regexp')
  if (regexBytes) {
    const r = sectionReader(regexBytes), n = r.varint()
    for (let j = 0; j < n; j++) { const sid = r.varint(); regexes.set(sid, [JSON.parse(r.str(r.varint())), r.str(r.varint())]) }
  }
  const fieldBytes = customSection(mod, 'jz:fields')
  if (fieldBytes) {
    const r = sectionReader(fieldBytes), count = r.varint()
    for (let sid = 0; sid < count; sid++) {
      const row = [], n = r.varint()
      for (let i = 0; i < n; i++) {
        const header = r.varint()
        row.push([header >>> 3, header & 1 ? r.varint() : -1, header & 2 ? r.varint() : 0, header & 4 ? Number(r.str(r.varint())) : null])
      }
      fields.push(row)
    }
  }
  const schemaBytes = customSection(mod, 'jz:schema')
  if (schemaBytes) {
    const r = sectionReader(schemaBytes)
    const dec = () => {
      const t = r.u8()
      if (t === 0) return null
      if (t === 1) return [null, dec()]
      const name = r.str(r.varint())
      return t === 3 ? JSON.parse('"' + name + '"') : name
    }
    const n = r.varint()
    for (let j = 0; j < n; j++) { const k = r.varint(), props = []; for (let p = 0; p < k; p++) props.push(dec()); schemas.push(props) }
  }
  return { errorClasses, brands, regexes, fields, schemas, views }
}

/**
 * A module's tables merged into a memory's, on copies: the memory's own tables
 * do not change, so a rejected module leaves no trace, and `instantiate` runs
 * the merge before a module links to the memory it would share, where its
 * start function and data would already have written. The enhancer commits
 * the result. The first module's numbering is authoritative: a sid already
 * known keeps its class and brand.
 *
 * A pointer carries the schema id its module compiled with, so every schema
 * must bind at that id here: a module whose schema would bind at another id
 * is rejected. Modules sharing a memory agree on their ids (one compilation,
 * or the same module again) or take memories of their own. The dedup key
 * mirrors ctx.schema.register's compile-time key (module/schema.js): the
 * property list as JSON (a separator could not tell `a\u0001b, c` from
 * `a, b\u0001c`) salted with the module's own class name for the schema (all
 * seven built-in Error classes share the props ['message', 'name'] and are
 * distinct only by their salt; two user classes of one field list likewise).
 * `_schemaKeyToId` remembers the salted key per id across merges: `schemas`
 * itself stays the plain list of property names that `read` indexes by sid,
 * from which a salted key cannot be recovered.
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
  let mem, wasmExports, extMap, mod, symbols
  if (src instanceof WebAssembly.Memory) {
    mem = src
    wasmExports = null
    extMap = null
    mod = null
    symbols = symbolsOf(mem, null, null)
  } else {
    // Instance result: { module, instance, exports, extMap }
    const raw = src?.instance?.exports || src?.exports || src
    mem = src?.exports?.memory || raw.memory
    // Memoryless module (SSO strings / atoms / numbers only — no linear memory):
    // hand back a minimal reader instead of null so callers can still decode its
    // boundary values from bits. `read`/`wrapVal` cover the value forms that exist
    // without memory; `scalar` flags the fast path that skips heap marshaling.
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

  // Allocator scaffold: bumps the exported `$__heap` global (or memory[1020] for
  // shared memory). Wasm `_alloc` takes over when exported; `_clear`/jsReset rewinds.
  const { alloc: jsAlloc, reset: jsReset, initHeapPtr, top, setTop, used, markBase } = makeJsAllocator(mem, wasmExports?.__heap)
  // `_alloc`'s i32 result crosses the wasm→JS boundary SIGNED (same ToInt32 rule as any
  // other i32 — see makeJsAllocator's comment); `>>> 0` restores the true unsigned address
  // once the heap grows past 2 GiB, matching jsAlloc's own already-unsigned return.
  const wasmAlloc = wasmExports?._alloc && (bytes => wasmExports._alloc(bytes) >>> 0)
  let alloc = wasmAlloc || jsAlloc
  const reset = wasmExports?._clear || jsReset
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

  // The module's tables joined to the memory's (rejected before anything
  // changes when the module compiled with other ids), committed as a whole
  Object.assign(mem, mergeTables(mem, mod ? moduleTables(mod) : NO_TABLES))
  if (wasmExports?.__view_data) mem.viewData = wasmExports.__view_data
  if (wasmExports?.__obj_props) mem.objProps = wasmExports.__obj_props
  if (wasmExports?.__obj_deleted) mem.objDeleted = wasmExports.__obj_deleted

  mem._symbols = symbols

  // If already enhanced, just update bindings (new module compiled into same memory)
  if (_enhanced.has(mem)) {
    if (wasmAlloc) { alloc = wasmAlloc; mem.alloc = alloc }
    mem.reset = () => { mem._views = new WeakMap(); reset() }
    if (extMap) mem._extMap = extMap
    return mem
  }

  // Patch methods onto the Memory instance
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

  mem.Array = (data) => {
    const n = data.length, off = hdr(n, n, n * 8), source = Object(data)
    // Stage as i64 bits, not as JS Numbers: V8 may transition a JS Array holding
    // NaN-payload doubles to HOLEY_DOUBLE_ELEMENTS, which canonicalizes the NaN
    // payload to 0x7FF8000000000000 — destroying the type/offset bits.
    const wrapped = new BigInt64Array(n)
    for (let i = 0; i < n; i++) wrapped[i] = i in source ? bits(mem.wrapVal(source[i])) : TOMB_BITS
    const dst = new BigInt64Array(mem.buffer, off, n)
    for (let i = 0; i < n; i++) dst[i] = wrapped[i]
    return ptr(1, 0, off)
  }

  mem.String = (str) => {
    if (str.length <= 6 && /^[\x00-\x7f]*$/.test(str)) {
      // 7-bit ASCII SSO: char i at payload bit i*7, len at bits 42-44 (see module/string.js codec).
      let p = 0n
      for (let i = 0; i < str.length; i++) p |= BigInt(str.charCodeAt(i)) << BigInt(i * 7)
      p |= BigInt(str.length) << 42n
      return ptr(4, Number(p >> 32n) | LAYOUT.SSO_BIT, Number(p & 0xFFFFFFFFn))  // STRING + SSO_BIT
    }
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
    if (typeof v === 'object') { const own = mem._views?.get(v); if (own !== undefined) return own }
    if (typeof v === 'number') return coerce(v)
    if (typeof v === 'boolean') return v ? TRUE_NAN : FALSE_NAN
    if (typeof v === 'string') return mem.String(v)
    if (typeof v === 'symbol') return mem._symbols.write(v)
    // A BigInt that is a NaN-box (jz's i64 carrier — e.g. a value pre-built via memory.String/
    // ptr/BigInt) passes straight through. A plain bigint VALUE has no per-slot host-ABI
    // evidence to consult here — wrapVal is the GENERAL memory.*/mem.Array/mem.Hash/host-import-
    // return marshalling entry, not the export-argument path (i64Arg, below, consults
    // jz:hostabi per param; the rest-element path consults its `rest` flag per element) — so
    // this refuses loudly instead of the phase-c-C4b-killed silent-wrong fallback
    // (`mem.String(v.toString())`, a decimal string a wasm numeric parser happens to accept —
    // every consumer expecting a real BigInt got a corrupted value instead with no error, the
    // worst class).
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
    // An erased host slot has no source-level proof that downstream code uses
    // the BigInt element domain. Keep ordinary numeric TypedArrays zero-copy-
    // compatible, but reject evidence-free BigInt typed ingress rather than
    // forcing every numeric hot loop onto the tagged/boxing path. Programs
    // that construct BigInt typed storage internally retain full support.
    if (typedName === 'BigInt64Array' || typedName === 'BigUint64Array' ||
        typedName === 'Float16Array' || typedName === 'Uint8ClampedArray')
      throw new TypeError(`jz: host ${typedName} at an untyped boundary is not supported — construct it inside the compiled source so its element storage policy is provable`)
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

  // First-class jz HASH from a plain JS object — the schema-less marshal. Builds the
  // kernel's exact open-addressed table ([seq<<32|hash:i64][key:f64][val:f64] × cap,
  // home slot = hash & (cap-1), linear probe, len/cap header at -8/-4) so every
  // wasm-side dyn op — reads, writes, NEW props, growth, delete, iteration — runs
  // natively with stable identity. The External reflection path decodes/re-marshals
  // per access, so nested container mutation (`params.P[i][j] = …`) lands on
  // marshaling copies and silently vanishes — a params-bag must be a real hash.
  // Hash twins of module/collection.js (clampHash / ssoMix / unitFnv) — MUST agree
  // with __str_hash or wasm probes start at the wrong home slot and miss.
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
    // cap × (24-B entry + 4-B probe hash lane) — collection.js's exact layout;
    // the lane (after the entries) is what wasm probes walk
    const off = hdr(entries.length, cap, cap * 28)
    // Stage every slot as i64 bits (empty = 0) — same NaN-canonicalization dodge as mem.Array.
    const staged = new BigInt64Array(cap * 3)
    const lane = new Int32Array(cap)
    entries.forEach(([k, v], seq) => {
      const keyBox = typeof k === 'symbol' ? mem._symbols.write(k) : mem.String(k)
      const h = jzStrHash(keyBox)
      let idx = h & (cap - 1)
      while (staged[idx * 3] !== 0n) idx = (idx + 1) & (cap - 1)
      staged[idx * 3] = (BigInt(seq) << 32n) | BigInt(h >>> 0)
      staged[idx * 3 + 1] = bits(keyBox)
      staged[idx * 3 + 2] = bits(mem.wrapVal(v))
      lane[idx] = h | 0
    })
    const dst = new BigInt64Array(mem.buffer, off, cap * 3)
    dst.set(staged)
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
      : rule && (rule[0] & (1 << PTR.TYPED)) && ArrayBuffer.isView(value) && ELEMS[value.constructor.name]
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
    const schema = schemas[sid], n = schema.length, raw = alloc(n * 8)
    // Stage as i64 bits so V8 can't canonicalize NaN-payload pointers across
    // recursive allocations. See mem.Array for the same pattern — and route
    // every property value through mem.wrapVal the same way mem.Array/
    // mem.Hash do: this loop used to hand-roll a partial null/string/array
    // dispatch and fall through to bare `bits(v)` for everything else
    // (numbers were incidentally fine; a plain BIGINT property value was
    // not — silently stored as raw unmarked bits, no BigInt tag, instead of
    // wrapVal's post-C4b typed throw. Nested plain objects/typed arrays/
    // buffers/functions were equally unhandled). One dispatch, no duplicate
    // logic to drift out of sync with wrapVal's.
    const wrapped = new BigInt64Array(n)
    for (let i = 0; i < n; i++) wrapped[i] = bits(wrapField(sid, i, obj[schema[i]]))
    const dst = new BigInt64Array(mem.buffer, raw, n)
    for (let i = 0; i < n; i++) dst[i] = wrapped[i]
    return ptr(6, sid, raw)
  }

  // The live entries of a HASH (7), SET (8) or MAP (9) at `off` in insertion
  // order, as __coll_order walks them: a durable-heap tombstone is no key.
  const liveSlots = (off, t) => {
    const m = dv(), cap = m.getInt32(off - 4, true), stride = t === 8 ? 16 : 24, slots = []
    for (let i = 0; i < cap; i++) {
      const slot = off + i * stride, hash = m.getBigUint64(slot, true)
      if (hash && (t !== 7 || Number(hash >> 32n) !== HIDDEN_PROPERTY_SEQ) && m.getBigUint64(slot + 8, true) !== 0x7FF87FFFFFFFFFFFn)
        slots.push([Number(hash >> 32n), slot])
    }
    return slots.sort((a, b) => a[0] - b[0]).map(([, slot]) => slot)
  }
  // A dictionary's [key, value] pairs, the box followed past a grow.
  const hashEntries = (bits, fnOf = null) => {
    const m = dv()
    let off = offset(bits)
    while (m.getInt32(off - 4, true) === -1) off = m.getUint32(off - 8, true)
    return liveSlots(off, 7).map(slot => [mem.read(m.getBigInt64(slot + 8, true), fnOf), mem.read(m.getBigInt64(slot + 16, true), fnOf)])
  }

  // `fnOf` reads a closure as a JS function that calls it (wrap's per-instance
  // reader: a closure's table index names a function of the module that made it).
  mem.read = function(p, fnOf = null) {
    if (Array.isArray(p)) return p.map(v => mem.read(v, fnOf))  // multi-value tuple
    if (typeof p === 'number') {
      if (p === p) return p              // genuine number passthrough (NaN fails ===)
      p = f64ToI64(p)                    // f64 NaN-box (intact on V8) → bits; decode below
    } else if (typeof p !== 'bigint') {
      return p                           // already a decoded JS value (string/object/…) — passthrough
    }
    // p is now i64 bits (BigInt). Decode with integer ops — never materialize as f64.
    if (!isBox(p)) return i64ToF64(p)    // non-NaN bits → genuine number
    const m = dv(), t = type(p), a = aux(p)
    let off = offset(p)
    if (t === PTR.ATOM && a >= SYMBOL_MIN && p !== TOMB_BITS) return mem._symbols.read(p)
    // Arrays and collections retain their identity when storage grows.
    if (t === 1 || t >= 7 && t <= 9)
      while (m.getInt32(off - 4, true) === -1) off = m.getUint32(off - 8, true)
    if (t === 0 && off === 0) {
      if (a === 0) return NaN
      if (a === 1) return null
      if (a === 2) return undefined
      if (a === 4) return false
      if (a === 5) return true
    }
    if (t === 11 && mem._extMap) return mem._extMap[off]
    if (t === 10 && fnOf) {
      if (off >= mem._above) mem._held = true
      return fnOf(p)
    }
    if (t === 1) {  // ARRAY
      const len = m.getInt32(off - 8, true), out = new Array(len)
      for (let i = 0; i < len; i++) {
        const value = m.getBigInt64(off + i * 8, true)
        if (value !== TOMB_BITS) out[i] = mem.read(value, fnOf)
      }
      return out
    }
    if (t === 3) {  // TYPED
      // A view of the module's memory: the bytes it shows stay while the host
      // holds it (`held`, for the call that returned it, interop `settled`).
      const held = (at) => { if (at >= mem._above) mem._held = true; return at }
      if (a & DATA_VIEW_FLAG) return new DataView(mem.buffer, held(m.getInt32(off + 4, true)), m.getInt32(off, true))
      const elem = a & 7
      const [, stride] = ELEM_BY_ID[elem]
      const Ctor = (a & 16) ? BigInt64Array
        : (a & 32)
          ? (globalThis.Float16Array ?? (() => { throw new Error('decoding a Float16Array result needs a host with Float16Array (Node ≥ 24 / modern browsers)') })())
          : (a & 64) ? Uint8ClampedArray
          : [Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array][elem]
      if (a & 8) {
        const byteLen = m.getInt32(off, true), dataOff = m.getInt32(off + 4, true)
        return new Ctor(mem.buffer, held(dataOff), byteLen / stride)
      }
      const byteLen = m.getInt32(off - 8, true)
      return new Ctor(mem.buffer, held(off), byteLen / stride)
    }
    if (t === 2) {  // BUFFER
      const byteLen = m.getInt32(off - 8, true)
      const out = new ArrayBuffer(byteLen)
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
    // A boxed BigInt's 8-byte payload is the raw two's-complement i64.
    if (t === 5) return m.getBigInt64(off, true)  // BIGINT
    if (t === 6) {  // OBJECT
      // An object literal's accessor reads through its getter: the module
      // copies such an object's data into a dictionary, decoded below.
      // Error transport reads its stored message before constructing the host Error.
      if (mem.views?.has(a) && mem.viewData && !mem.errorSidToClass?.has(a) && !mem.regexOfSid?.has(a)) return mem.read(mem.viewData(p), fnOf)
      const keys = mem.schemas[a]
      if (!keys) { if (off >= mem._above) mem._held = true; return p }
      const re = mem.regexOfSid?.get(a), obj = re ? new RegExp(re[0], re[1]) : {}
      // A deleted slot keeps undefined and a bit of the mask (layout.js
      // deletedSlotWat): from slot 31 on one sticky bit covers the undefined ones.
      const mask = mem.objDeleted ? mem.objDeleted(p) : 0
      for (let i = 0; i < keys.length; i++) {
        const rule = mem.fieldContracts[a]?.[i], raw = m.getBigInt64(off + i * 8, true)
        if (mask && (i < 31 ? (mask >>> i) & 1 : (mask >>> 31) & 1 && raw === UNDEF_NAN)) continue
        if (rule?.[2] === 8) throw new TypeError('jz: field ' + keys[i] + ' has ambiguous raw BigInt storage; use distinct object shapes')
        let value = rule?.[2] === 4 ? raw : mem.read(raw, fnOf)
        if (value != null && rule && (rule[0] & ~FIELD.NULLISH) === FIELD.BOOL) value = !!value
        obj[keys[i]] = value
      }
      // A property stored outside the layout (through an alias, a destructuring
      // target, a helper's parameter) is in the object's dictionaries: its
      // header's, then the one a durable object's offset keys (module
      // __obj_props). A later one's value replaces an earlier one's in place.
      if (mem.objProps) for (const which of [0, 1]) {
        const d = mem.objProps(p, which)
        if (d) for (const [key, value] of hashEntries(d, fnOf)) obj[key] = value
      }
      fnOf?.owners.set(obj, p)
      return obj
    }
    if (t >= 7 && t <= 9) {  // HASH / SET / MAP share the insertion sequence.
      if (t === 8) return new Set(liveSlots(off, t).map(slot => mem.read(m.getBigInt64(slot + 8, true), fnOf)))
      const entries = liveSlots(off, t).map(slot => [mem.read(m.getBigInt64(slot + 8, true), fnOf), mem.read(m.getBigInt64(slot + 16, true), fnOf)])
      if (t !== 7) return new Map(entries)
      const out = Object.fromEntries(entries)
      fnOf?.owners.set(out, p)
      return out
    }
    // a handle on the module's memory, held as the view of a typed array is
    if (t !== 0 && off >= mem._above) mem._held = true
    return i64ToF64(p)  // canonical NaN-number, a CLOSURE without a reader, unknown: reinterpret to f64
  }

  mem.write = function(p, data) {
    const t = type(p)
    let off = offset(p), m = dv()
    if (t === 1) {
      while (m.getInt32(off - 4, true) === -1) off = m.getUint32(off - 8, true)
      const cap = m.getInt32(off - 4, true), length = data.length
      if (!Number.isSafeInteger(length) || length < 0) throw new RangeError('mem.write: invalid array length')
      if (length > cap) throw Error(`mem.write: ${data.length} elements exceeds this array's capacity of ${cap} — allocate it with a larger capacity, or write ${cap} or fewer elements`)
      // Recursive marshalling can grow memory. Commit only after all values
      // marshal, then reacquire the destination view. Failed staging leaves
      // destination contents/length intact; allocations are reclaimed by reset.
      const staged = new BigInt64Array(length), source = Object(data)
      for (let i = 0; i < length; i++) staged[i] = i in source ? bits(mem.wrapVal(source[i])) : TOMB_BITS
      m = dv()
      for (let i = 0; i < staged.length; i++) m.setBigInt64(off + i * 8, staged[i], true)
      m.setInt32(off - 8, staged.length, true)
    } else if (t === 3) {
      const a2 = aux(p), elem = a2 & 7
      const [, stride, , setter] = (a2 & 16) ? ELEMS.BigInt64Array : ELEM_BY_ID[elem]
      const byteLen = data.length * stride
      if (a2 & 8) {
        const viewByteLen = m.getInt32(off, true), dataOff = m.getInt32(off + 4, true)
        if (byteLen > viewByteLen) throw Error(`mem.write: ${byteLen} bytes exceeds this typed array view's size of ${viewByteLen} bytes — allocate a larger view, or write fewer elements`)
        for (let i = 0; i < data.length; i++) m[setter](dataOff + i * stride, data[i], true)
      } else {
        const byteCap = m.getInt32(off - 4, true)
        if (byteLen > byteCap) throw Error(`mem.write: ${byteLen} bytes exceeds this typed array's capacity of ${byteCap} bytes — allocate it with a larger capacity, or write fewer elements`)
        m.setInt32(off - 8, byteLen, true)
        for (let i = 0; i < data.length; i++) m[setter](off + i * stride, data[i], true)
      }
    } else if (t === 6) {
      const schema = mem.schemas[aux(p)]
      if (!schema) throw Error(`mem.write: this pointer's schema id (${aux(p)}) has no compiled OBJECT schema — write to a pointer returned by mem.Object() for a schema this program compiled`)
      const staged = []
      for (const k of Object.keys(data)) {
        const i = schema.indexOf(k)
        if (i >= 0) staged.push([i, bits(wrapField(aux(p), i, data[k]))])
      }
      m = dv()
      for (const [i, value] of staged) m.setBigInt64(off + i * 8, value, true)
    } else {
      throw Error(`mem.write only supports ARRAY, TYPED array, and OBJECT pointers — this pointer is a different kind (type tag ${t})`)
    }
  }

  mem.alloc = alloc
  // The compiled reset owns the post-init mark, cache invalidation and durable
  // state healing. A JS-only memory has no runtime state and just rewinds. The
  // views the module left on host objects (`__ext_set`) name storage a reset frees.
  mem._views = new WeakMap()
  mem.reset = () => { mem._views = new WeakMap(); reset() }

  // TypedArray constructors: memory.Float64Array(data), etc.
  // Bulk-copy path: when input is a TypedArray whose element type matches
  // the target (same stride), use .set() for a fast memcpy instead of
  // per-element DataView writes. Falls back to DataView for mismatched types.
  const TA = [Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array]
  TA[65] = Uint8ClampedArray
  if (globalThis.Float16Array) TA[35] = globalThis.Float16Array
  for (const [name, [elemId, stride, , setter]] of Object.entries(ELEMS)) {
    mem[name] = (data) => {
      // Coerce before allocating, and snapshot views over our growable buffer.
      if (TA[elemId] && (!(data instanceof TA[elemId]) || data.buffer === mem.buffer)) data = new TA[elemId](data)
      const n = data.length, bytes = n * stride, off = hdr(bytes, bytes, bytes)
      // Same-type source → native memcpy via `.set` (incl. stride-1 Uint8Array:
      // a multi-MB file copied byte-by-byte through DataView dominates decode).
      if (TA[elemId] && data instanceof TA[elemId]) {
        new TA[elemId](mem.buffer, off, n).set(data)
      } else {
        const m = dv()
        for (let i = 0; i < n; i++) m[setter](off + i * stride, data[i], true)
      }
      return ptr(3, elemId, off)
    }
  }

  // Zero-copy input: reserve a typed-array region in wasm memory and return BOTH
  // a live `view` over it and the NaN-box `box` pointer to pass as an argument.
  // The caller fills `view` directly (one I/O-side copy, no second JS→wasm copy)
  // and hands `box` to the export, which reads the bytes in place. Decoded typed
  // arrays already come back as views (mem.read), so a decode can be copy-free
  // end-to-end. LIFETIME: `view` is detached by any mem.grow() (alloc past the
  // current buffer) and clobbered by mem.reset()/the next decode — re-derive a
  // fresh view with mem.read(box) after growth, or copy out what must persist.
  // Back the module with a shared memory (WebAssembly.Memory{shared:true}) to
  // keep views valid across grow and to hand them to a worker/AudioWorklet.
  mem.allocTyped = (Ctor, n) => {
    const meta = ELEMS[Ctor?.name]
    if (!meta) throw Error(`mem.allocTyped: ${Ctor?.name ?? Ctor} is not a supported typed array constructor — pass one of ${Object.keys(ELEMS).join(', ')}`)
    const [elemId, stride] = meta
    const bytes = n * stride, off = hdr(bytes, bytes, bytes)
    return { view: new Ctor(mem.buffer, off, n), box: ptr(3, elemId, off) }
  }

  _enhanced.add(mem)
  return mem
}

/**
 * Wrap raw WASM exports with JS calling convention adaptation.
 * Handles: undefined → sentinel NaN for defaults, rest-param array packing.
 */
export const wrap = (memSrc, inst, state) => {
  const restFuncs = new Map()
  const mod = inst ? memSrc : memSrc.module || memSrc
  const realInst = inst || memSrc.instance || memSrc
  const td = TEXT_DEC
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
  // i64-carrier map: per export, which params ride i64 and whether a result
  // takes generic tagged decode. A proven raw BigInt result has no result flag.
  const i64Exp = new Map()
  const i64Bytes = customSection(mod, 'jz:i64exp')
  if (i64Bytes) {
    try { for (const e of JSON.parse(td.decode(i64Bytes))) i64Exp.set(e.name, { p: new Set(e.p || []), r: !!e.r, t: e.t || null, k: new Set(e.k || []), v: e.v || null }) }
    catch { /* ignore */ }
  }
  // jz:hostabi — the ONE authority for per-slot host-BigInt ingress policy
  // (phase-c C4b, audit P0 #1/#2). Per export: `raw` = i64 param indices the
  // plan proved ALWAYS bigint (plain bigint crosses with no box —
  // architecturally unreachable at the export boundary today, see
  // src/compile/index.js's jz:hostabi doc for the reachability proof; the
  // field is real and consulted below, just never populated by the current
  // compiler). `tag` = indices the plan proved MAY be bigint — box via
  // mem.BigInt (the one reachable evidenced state, formerly jz:bigintbox's
  // sole content). `val` = the `tag` slots whose function reads the parameter
  // only as a scalar value (never a receiver, a callee, an argument, a stored
  // or returned value): EVERY BigInt there is a value and is boxed, whatever
  // its bits, so a handle cannot be passed at a `val` slot and a value whose
  // bits carry the NaN-box prefix crosses as itself. `rest` = truthy only
  // when the plan can prove bigint evidence for this export's rest-parameter
  // elements (never true today — no evidence source exists for host-populated
  // rest elements). A slot in neither `raw` nor `tag` has no evidence of any
  // kind: i64Arg (below) rejects a plain bigint there instead of guessing
  // from the absence. `skip` names slots the complete binding-use census
  // never observes: they cross without conversion, preserving only undefined
  // so a default initializer still runs when due.
  // jz:release — exports whose calls keep nothing they allocate or are handed
  // (optimize/arena-rewind.js): the wrapper rewinds the heap to where it stood
  // before the arguments were copied in. `flag`: those whose frames run escape
  // sites, released only when the call left the exported escape flag down.
  // `host`: those of them whose frame releases nothing by itself: the
  // wrapper's rewind is the only one.
  // `ask`: those whose result may be a heap value, which the frame keeps and
  // the wrapper releases once it holds a copy.
  const releases = new Set(), flagged = new Set(), hostReleased = new Set(), numberResult = new Set()
  const releaseBytes = customSection(mod, 'jz:release')
  if (releaseBytes) {
    try {
      const r = JSON.parse(td.decode(releaseBytes))
      for (const n of r.release) releases.add(n)
      for (const n of r.flag ?? []) flagged.add(n)
      for (const n of [...r.host ?? [], ...r.ask ?? []]) hostReleased.add(n)
      for (const n of r.number ?? []) { releases.add(n); hostReleased.add(n); numberResult.add(n) }
    } catch { /* ignore */ }
  }
  const esc = realInst.exports.__esc, setBase = realInst.exports.__base, survive = realInst.exports.__survive
  const hostAbiExp = new Map()
  const hostAbiBytes = customSection(mod, 'jz:hostabi')
  if (hostAbiBytes) {
    try {
      for (const e of JSON.parse(td.decode(hostAbiBytes)))
        hostAbiExp.set(e.name, { raw: new Set(e.raw || []), tag: new Set(e.tag || []), val: new Set(e.val || []), skip: new Set(e.skip || []), rest: !!e.rest })
    } catch { /* ignore */ }
  }
  const mem = memory(memSrc)
  // Async boundary: a program with async source anywhere in its graph exports
  // __mt_drain / __p_state / __p_value (the `jz:async` std module's contract,
  // re-exported by prepare). Every export call ends
  // the "turn" — the microtask queue drains — and a promise-shaped return
  // adopts into a HOST Promise: settled ones immediately, pending ones (parked
  // on a timer) settle from the after-tick sweep. Sync modules: finishRet is
  // pass-through, zero overhead beyond one truthiness check.
  const mtDrain = realInst.exports.__mt_drain
  const pState = realInst.exports.__p_state
  const pValue = realInst.exports.__p_value
  const asyncMod = !!(mtDrain && pState && pValue)
  const pending = []
  // Match the raw ret's carrier to the reader's param lane (i64Exp filled
  // below); a reader's own result may ride the i64 lane too — __p_state's
  // NUMBER comes back as f64 bits (reinterpret), __p_value's BOX stays raw
  // bits for mem.read.
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
    // Async host imports: a thenable returned by a host import becomes a jz
    // promise (made + settled through the runtime's exports, lane-matched).
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
  // `raw` may arrive as either a genuine i64 BigInt (heap-module exports with
  // an i64-carrier result) or a NaN-boxed f64 number (the legacy carrier) —
  // same two shapes `mem.read` itself normalizes at its own entry (line
  // ~500). Only a NaN bit pattern can ever be a pointer; a real number can't,
  // so a non-NaN f64 short-circuits to null with no BigInt conversion.
  const rawBoxBits = (raw) =>
    typeof raw === 'bigint' ? raw : (typeof raw === 'number' && raw !== raw ? f64ToI64(raw) : null)
  // Error-class sid lookup shared by the escaping-throw path (decodeThrown,
  // below) and the ordinary RETURN-value path (readRet, below) — audit-#10
  // finding-4: a RETURNED (not thrown) Error previously decoded as a plain
  // {message,name} object via mem.read's generic OBJECT case with no upgrade
  // at all, because only decodeThrown ever consulted `mem.errorSidToClass`
  // (error-object-design.md (git history) §"Interop consequence" / audit-#9 P0-2's
  // 'jz:errcls' custom section, read into this map at instantiation, above).
  // Gated the same way on both ends: `raw` must be a genuine NaN-boxed OBJECT
  // pointer (`isBox` + `type === 6`) before its aux bits are trusted as a sid
  // — a coincidental aux value on some OTHER pointer type can never spoof a
  // class this way.
  const errorSidClassOf = (raw) => {
    const b = rawBoxBits(raw)
    return b != null && isBox(b) && type(b) === 6 ? (mem.errorSidToClass?.get(aux(b)) ?? null) : null
  }
  // The RETURN side of finding-4's fix: `finishRet(ret, readRet)` replaces
  // `finishRet(ret, r => mem.read(r))` at both heap-module export wrappers
  // below. A returned Error upgrades the SAME way a thrown one does
  // (errorSidClassOf + `new Ctor(message)`), minus `.cause`/`.thrown` — there
  // is no host-side exception to attach a cause to on a plain return. Only
  // the top-level result (and each element of a top-level multi-value tuple,
  // mirroring mem.read's own `Array.isArray(p)` recursion at its entry) is
  // checked — an Error nested inside a returned array/object/Map property
  // still decodes as a plain {message,name} object, same as it did before
  // this fix (not the named repro, not chased here).
  const readRet = (r) => {
    if (Array.isArray(r)) return r.map(readRet)
    const decoded = mem.read(r, fnOf)
    const errClassName = errorSidClassOf(r)
    return errClassName != null ? new (globalThis[errClassName] ?? Error)(decoded.message) : decoded
  }
  const lastErrBits = realInst.exports.__jz_last_err_bits
  // audit-#8 P1-1: `__jz_last_err_bits` is declared `(mut i64)` at the jz source
  // level (src/compile/index.js ensureThrowRuntime), but watr's OWN generic
  // optimizer (the external `watr/optimize`, run after jz's pipeline — see
  // src/optimize/watr-tail.js) independently downgrades an unwritten global to
  // immutable as a size win: when every throw site referencing it folds away for
  // a GIVEN compiled module (e.g. an all-literal `typeof BigInt("1")` — no
  // dynamic input can ever reach a throw), no `global.set` survives anywhere in
  // that module, and watr emits a plain (const) global instead of `(mut i64)`.
  // Setting `.value` on a const `WebAssembly.Global` throws TypeError
  // unconditionally per the JS API spec, regardless of the value written — so
  // BOTH decodeThrown's existing per-decode reset (below) and the wrapper-entry
  // belt-and-braces reset (each export wrapper, further down) must check this
  // FIRST. Probed once per instance (mutability can't change afterward): set the
  // global to its own current value inside try/catch — a const global rejects
  // that identically to any other write, so a caught TypeError there means
  // read-only. (Reaching decodeThrown here at all with an immutable global means
  // the RuntimeError/Exception came from something OTHER than jz's own $__jz_err
  // machinery — genuinely nothing to decode from this marker.)
  let lastErrBitsWritable = false
  if (lastErrBits) { try { lastErrBits.value = lastErrBits.value; lastErrBitsWritable = true } catch { /* const global — leave false */ } }
  const decodeThrown = error => {
    const isException = error instanceof WebAssembly.Exception
    // A no-user-EH module lowers every internal `throw` to `unreachable` (kept in
    // the wasm MVP — see pruneUnusedThrowRuntime) but still writes
    // __jz_last_err_bits immediately before it traps. A RuntimeError with a
    // nonzero marker is that same trap, decodable exactly like the Exception
    // path below; a RuntimeError with a ZERO marker is a genuine foreign trap
    // (OOB, stack overflow, …) that no throw site marked — rethrow undecoded.
    const isMarkedTrap = !isException && error instanceof WebAssembly.RuntimeError &&
      lastErrBits && lastErrBits.value !== 0n
    if (!isException && !isMarkedTrap) throw error
    if (!lastErrBits) throw error
    const errBits = lastErrBits.value  // i64 bits (BigInt)
    // Consume the marker on EVERY decode (Exception path included), not just the
    // trap path: an Exception leaves it nonzero too, and a later genuine foreign
    // trap on the SAME instance would otherwise read that stale value and
    // misdecode as the earlier, already-handled error. Nothing else reads this
    // global (host- or wasm-side) between throws, so the reset is safe. Skipped
    // when watr proved the global const (see lastErrBitsWritable above) — an
    // immutable marker can't be stale (it was never written), and writing to it
    // would throw.
    if (lastErrBitsWritable) lastErrBits.value = 0n
    // Memoryless module: the thrown value is a number/atom/SSO string — decode it
    // from bits. (A heap Error/string can only exist when the module has memory.)
    const code = Number(errBits >> 32n) === ERROR_CODE_HI ? Number(errBits & 0xffffffffn) : null
    const info = code == null ? undefined : ERR_INFO[code]
    const value = code == null ? (mem ? mem.read(errBits) : decode(errBits)) : code
    if (value instanceof Error) throw value
    // A real jz Error object (audit-#9 P0-2 brand redesign, error-object-
    // design.md §1: PTR.OBJECT, schema ['message','name']) decodes via
    // mem.read's generic OBJECT case (line ~508) to a plain JS object
    // {message, name} — never `instanceof Error` on this side, since it's a
    // schema-shaped dict, not a host Error. Class identity is NOT decodable
    // from the object's own fields (unlike the old __errcls__-slot design):
    // it lives in the pointer's schema id (aux bits), a REAL hidden brand no
    // source-level write can reach or forge — read it straight off the raw
    // bits BEFORE any property decode, gated on the module's 'jz:errcls' sid
    // map (mem.errorSidToClass, populated above) so a plain user-thrown
    // object coincidentally shaped `{name:'Array', message:'x'}` can never
    // upgrade (its sid, whatever it is, was never minted by errorSid — trust
    // requires the type tag to be OBJECT too, not just any aux value that
    // happens to numerically coincide with a minted error sid).
    if (mem) {
      const errClassName = errorSidClassOf(errBits)
      if (errClassName != null && value != null) {
        const Ctor = globalThis[errClassName] ?? Error
        const wrapped = new Ctor(value.message)
        wrapped.cause = error
        wrapped.thrown = value
        if (state?.inHost) (state.caught ??= new WeakMap()).set(wrapped, errBits)
        throw wrapped
      }
    }
    // Only the private transport tag identifies an internal code. A user
    // number, including a colliding code, retains the generic thrown-value API.
    const Ctor = info ? (globalThis[info.name] ?? Error) : Error
    const wrapped = info ? new Ctor(info.message)
      : new Error(typeof value === 'string' ? value : String(value))
    wrapped.cause = error
    wrapped.thrown = value
    if (state?.inHost) (state.caught ??= new WeakMap()).set(wrapped, errBits)
    throw wrapped
  }
  // A closure the host holds (an export's result, a host call's argument)
  // reads as a JS function calling it through the module's trampoline, as an
  // export call runs: arguments wrapped, the result read, a throw decoded, a
  // promise adopted. Called as a method of an object read from the module,
  // it takes that object as `this`. Past the inline lanes a rest parameter
  // reads the whole argument list from an array.
  const callClosure = mem ? realInst.exports.__call_closure : null
  const lanes = callClosure ? callClosure.length - 4 : 0
  const closureArg = (v) => typeof v === 'bigint' && !isBox(v) && mem.BigInt ? mem.BigInt(v) : v
  // The call keeps its heap as an export that releases nothing does (a closure
  // has no `jz:release` of its own), and what it kept holds the heap of the
  // call around it (`enter`/`leave` below); a module with no heap has neither.
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
  }, { owners: new WeakMap() }) : null
  if (state) state.fnOf = fnOf
  const exports = {}
  // A call that crosses as it is. Every parameter is a number on its own lane
  // (no slot of the i64, externref or host-BigInt lanes, no typed slot, no
  // rest), so the engine's ToNumber is the whole marshalling, as it is on the
  // general path. A BigInt argument, which a number lane refuses by name or
  // reads as a handle, takes the general path; a result that is no number
  // takes its decoding (`settle`). Written out by arity: the call allocates
  // nothing. `begin` answers whether the call may cross so (a call made while
  // another runs tells it what it kept: the general path), `end` runs after
  // it, a throw included.
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
        if (big(a) || !begin()) return general(a)
        let threw = false
        try { return out(fn(a)) } catch (e) { threw = true; decodeThrown(e) } finally { end(threw) }
      }
      case 2: return (a, b) => {
        if (skip0 && a !== undefined) a = 0
        if (skip1 && b !== undefined) b = 0
        if (big(a) || big(b) || !begin()) return general(a, b)
        let threw = false
        try { return out(fn(a, b)) } catch (e) { threw = true; decodeThrown(e) } finally { end(threw) }
      }
      case 3: return (a, b, c) => {
        if (skip0 && a !== undefined) a = 0
        if (skip1 && b !== undefined) b = 0
        if (skip2 && c !== undefined) c = 0
        if (big(a) || big(b) || big(c) || !begin()) return general(a, b, c)
        let threw = false
        try { return out(fn(a, b, c)) } catch (e) { threw = true; decodeThrown(e) } finally { end(threw) }
      }
      default: return general
    }
  }
  const always = () => true, idle = () => {}
  // Per-position arg marshaller. Externref slots (jsstring carrier) pass the JS
  // value straight through, substituting a jsstring literal default for a missing
  // arg. An i64-carrier param (per jz:i64exp) gets the box bits: `coerce` for
  // pure-scalar modules, `mem.wrapVal` for heap modules. The box never materializes
  // as f64, so JSC can't canonicalize it.
  const i64Arg = (ie, ext, box, hostAbi, name, writeBack, shared = writeBack && new Map()) => (x, i) => {
    // An unused slot still distinguishes missing/undefined for its default.
    // No read means no ToNumber, boxing, getter or backing-store copy is due.
    if (hostAbi?.skip.has(i)) return ie?.p.has(i) ? x === undefined ? UNDEF_NAN : 0n : x === undefined ? undefined : 0
    if (ext?.has(i)) return x === undefined && ext.def?.has(i) ? ext.def.get(i) : x
    // A BigInt is a value at a `val` slot whatever its bits (the function reads
    // the parameter only as a scalar, so no handle belongs there); elsewhere
    // the NaN-box prefix marks a jz-minted handle passed back raw.
    const plainBigint = typeof x === 'bigint' && (hostAbi?.val?.has(i) || !isBox(x))
    // f64 slot: proven numeric (every box-capable param takes the i64 lane, per
    // jz:i64exp), so the JS-API's own ToNumber at the call is the exact JS coercion
    // for every host value: null → 0, undefined → NaN, "8" → 8, valueOf objects.
    // A jz-minted box reinterprets to its bits; a plain BigInt is a TypeError in
    // JS too, named here with the remedies instead of the engine's message.
    if (!(ie && ie.p.has(i))) {
      if (plainBigint) throw new TypeError(`jz: BigInt argument at param ${i} of ${name}() has no BigInt evidence in the compiled program — give the parameter a provable BigInt path (it then takes the tagged ingress), or pass a decimal string to a typeof-guarded normalizing parameter`)
      return typeof x === 'bigint' ? i64ToF64(x) : x
    }
    // Phase-C C4b (correct-or-reject, audit P0 #1: dispatch on jz:hostabi's
    // own per-slot enum — never a boolean guess from the absence of a
    // different signal). A plain JS BigInt VALUE (not a jz-built NaN-box
    // pointer — isBox check first, those pass through as always) has exactly
    // ONE authority for what happens at THIS slot:
    //   - raw: the plan proved the slot ALWAYS bigint — passes straight
    //     through with no box (wasm's native BigInt→i64 ToWebAssemblyValue
    //     coercion takes it from here). Architecturally unreachable at the
    //     export boundary today (src/compile/index.js's jz:hostabi doc has
    //     the reachability proof) — reserved, not guessed-into.
    //   - tag: the plan proved the slot MAY be bigint — box via mem.BigInt,
    //     wasm dispatches by tag (the one reachable evidenced state). A
    //     `val` slot is a tag slot where the prefix test above is off: every
    //     BigInt is a value and takes this box, so a value whose bits carry
    //     the prefix (0x7FF8000000000000n, the largest positive i64) crosses
    //     as itself instead of as a handle. A tag slot not in `val` keeps
    //     the prefix test: a host may still hand it a raw handle.
    //   - neither: no BigInt evidence of any kind — the legacy decimal-
    //     string accident only "worked" for typeof-guarded normalization
    //     params and silently garbled every numeric one (the dyn-keys
    //     zero-evidence pin) — refuses loudly with both remedies named
    //     instead.
    // A slot the compiler proved a numeric array-like (`t`, per jz:i64exp) is
    // normalized to that typed array before boxing: the body reads typed
    // storage. Element conversion is ToNumber, as the numeric reads would apply.
    // A `+` suffix marks a slot the body writes: the storage is copied back into
    // the host value after the call (the host array itself is never a view).
    // `Array+` is a plain array the body may store into: it crosses as itself.
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
      // An owned jz buffer of the slot's kind is the storage itself (zero
      // copy). A subarray of one (its box holds a descriptor, not the
      // elements) or a buffer of another kind converts through its view like
      // any host array, and what the call writes goes back into that buffer.
      // Explicit buffers use the public bigint pointer carrier. A Number NaN
      // remains a Number even when its payload happens to resemble a pointer.
      if (jzBuffer) {
        // its kind is in its box: a view is made only to convert it
        if (argKind(x) !== key || (aux(x) & TYPED_ELEM_VIEW_FLAG)) { if (writes) back = { box: x }; x = Ctor.from(mem.read(x)) }
      } else {
        if (writes && x != null && typeof x === 'object') back = hostBack(x)
        x = x instanceof Ctor ? x : Ctor.from(x)
      }
    }
    let w
    if (plainBigint) {
      if (hostAbi?.raw?.has(i)) w = x
      else if (hostAbi?.tag?.has(i)) w = mem.BigInt(x)
      else throw new TypeError(`jz: BigInt argument at param ${i} of ${name}() has no BigInt evidence in the compiled program — give the parameter a provable BigInt path (it then takes the tagged ingress), or pass a decimal string to a typeof-guarded normalizing parameter`)
    } else {
      w = box(x)
    }
    // i64-carrier slot: a raw JS boolean must cross as its TRUE_NAN/FALSE_NAN
    // atom, matching how the SAME slot already boxes null/undefined (via
    // coerce/mem.wrapVal, both already BigInt by the time `w` is built here).
    // Neither `coerce` nor `mem.wrapVal` special-case booleans — `box(x)`
    // leaves a boolean as a plain JS boolean (scalar module) or Number-
    // converts it (heap module) — so falling through to `bits(w)` below
    // would reinterpret ToNumber(x)'s float bits (1.0/0.0), indistinguishable
    // from a genuine number at typeof/===. This is the argument-side mirror
    // of the return-boxing gap (audit #5 item 2, ledger "KERNEL LEG ZERO
    // FAILS" boolconst row): same collision, opposite direction of the JS↔
    // wasm boundary. Checked on the ORIGINAL arg `x` (not `w`) — deliberately
    // independent of whatever coerce/wrapVal did to it.
    if (typeof x === 'boolean') return x ? TRUE_NAN : FALSE_NAN
    // i64-carrier slot: a string that coerce() left raw (scalar/memoryless module)
    // must be NaN-box encoded. SSO handles ≤6 ASCII chars without heap memory; longer
    // or non-ASCII strings need a heap that this module lacks — throw clearly.
    if (typeof w === 'string') {
      if (w.length > 6 || !/^[\x00-\x7f]*$/.test(w))
        throw new Error('jz: string arg too long or non-ASCII for memoryless module — compile with a string operation to enable heap marshaling')
      return encodeSSO(w)
    }
    const b = bits(w)                                // i64 param: pass the box bits
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
  // After the call: copy each array argument's copy back where it came from,
  // both read now, after anything the call grew. A typed target takes the
  // elements through `set` (converting to its own kind); a plain array takes
  // the numbers, element by element, and the length the module left it: its
  // non-numeric elements stay in the module, as README documents.
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
        if (ArrayBuffer.isView(dst)) dst.set(src.length > dst.length ? src.subarray(0, dst.length) : src)
        else for (let i = 0; i < dst.length && i < src.length; i++) dst[i] = src[i]
      } else if (type(b) === PTR.ARRAY) backArray(dst, b, back.cells)
    }
  }
  // A plain host array takes back its numbers at the length the module left it (a
  // store past the end grew it, a `length` store shrank it: the host array is the
  // one the function mutated), and the writes into each nested array or typed
  // array the call's copy still holds where it was made (one the module replaced
  // stays in the module, as a changed element does).
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
      if (type(e) === PTR.TYPED) { if (ArrayBuffer.isView(d)) { const src = mem.read(e); d.set(src.length > d.length ? src.subarray(0, d.length) : src) } }
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
    const m = new DataView(mem.buffer)
    let off = offset(box)
    while (m.getInt32(off - 4, true) === -1) off = m.getUint32(off - 8, true)
    return { m, off, n: m.getInt32(off - 8, true) }
  }

  // A call's heap: `enter` marks where the heap stood before the arguments
  // were copied in; `leave` rewinds to it when the export keeps nothing
  // (`jz:release`) and no call made inside it (a host import calling back into
  // the module) kept anything either. `mem._kept` carries that, per nesting.
  // An export whose frame runs escape sites (`flag`) releases only a call that
  // returned with no escape written below the mark: the escape flag holds the
  // lowest address one wrote into (all ones while none ran), saved and cleared
  // around the call as a conditional frame does it (optimize/arena-rewind.js).
  // A call that threw releases nothing.
  // JZ_DEBUG_POISON=1: a release overwrites what it frees, as a rewound frame does.
  const POISON = typeof process !== 'undefined' && process.env?.JZ_DEBUG_POISON === '1'
  // `__base` sets the mark of the outermost frame reading the flag and
  // answers what it held: the mark of a frame of the module that runs around
  // this call (a host function it called calls back), or all ones.
  const NO_MARK = -1 >>> 0
  let depth = 0
  const running = () => depth === 0 && (depth = 1) === 1
  const ran = (threw) => { depth = 0; if (threw && setBase) setBase(-1) }
  const enter = (flag) => {
    // no frame of the module runs around the first call: a mark a call that threw left behind goes
    if (setBase && depth === 0) setBase(-1)
    depth++
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
  // The result as the host takes it: a copy (a string, an array, an object,
  // a collection), or a value that names the module's memory (a typed array's
  // view, a closure's handle, a promise read as it settles). One that names
  // memory above the call's mark holds what the call allocated (`mark.held`).
  const settled = (mark, ret) => {
    const above = mem._above, held = mem._held
    mem._above = mark.top; mem._held = false
    try {
      const out = finishRet(ret, readRet)
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
  }

  // Pure scalar module (no memory): pass f64 values directly, no marshaling
  if (!mem || mem.scalar) {
    for (const [name, fn] of Object.entries(realInst.exports)) {
      if (typeof fn !== 'function') { exports[name] = fn; continue }
      const ext = extExp.get(name)
      const ie = i64Exp.get(name)
      const hostAbi = hostAbiExp.get(name)
      const len = fn.length
      const general = (...args) => {
        if (args.length > len) args.length = len
        while (args.length < len) args.push(undefined)
        // audit-#8 P1-1 belt-and-braces: decodeThrown already consumes the marker
        // on every decode, and every in-wasm catch/finally now consumes it too
        // (src/compile/emit.js) — this is defense-in-depth against a raw-instance
        // reuse or any as-yet-unknown in-wasm path that misses that consume, so a
        // fresh call never starts with a stale marker from a PRIOR call.
        if (lastErrBitsWritable) lastErrBits.value = 0n
        try {
          const ret = fn(...args.map(i64Arg(ie, ext, mem.wrapVal, hostAbi, name)))
          // A proven raw-BigInt result stays raw; tagged results set `r` and
          // take the generic decoder.
          if (typeof ret === 'bigint' && !(ie && ie.r)) return ret
          return mem.read(ret, fnOf)
        } catch (e) { decodeThrown(e) }
      }
      exports[name] = plainLanes(ie, ext, hostAbi) && !asyncMod
        ? crossing(fn, general, (ret) => typeof ret === 'bigint' && !(ie && ie.r) ? ret : mem.read(ret, fnOf), always, idle, hostAbi?.skip) : general
    }
    return exports
  }
  const memWrapVal = mem.wrapVal.bind(mem)
  // Rest-element policy (audit P0 #2: the rest path bypassed i64Arg entirely —
  // `mem.Array(args.slice(fixed))` ran every element through mem.wrapVal, so a
  // plain-bigint rest element tripped the SAME silent decimal-string accident
  // wrapVal itself now refuses instead of committing). Applied BEFORE
  // mem.Array, element-by-element: a jz-built NaN-box bigint (isBox) always
  // passes through; a plain bigint VALUE dispatches on THIS export's
  // jz:hostabi `rest` flag exactly like a fixed slot dispatches on raw/tag —
  // tag it if the plan proved rest elements may be bigint, else refuse loudly
  // (always today — no evidence source exists yet for host-populated rest
  // elements, see jz:hostabi's doc above).
  const restElemArg = (hostAbi, name) => (x) => {
    if (typeof x !== 'bigint' || isBox(x)) return x
    if (hostAbi?.rest) return mem.BigInt(x)
    throw new TypeError(`jz: BigInt argument in the rest arguments of ${name}() has no BigInt evidence in the compiled program — give the rest parameter a provable BigInt path (it then takes the tagged ingress), or pass a decimal string`)
  }
  for (const [name, fn] of Object.entries(realInst.exports)) {
    if (fn === setBase || fn === survive || name === '__root_reset') continue   // the host's own handles on the module, no exports of the program
    if (restFuncs.has(name) && typeof fn === 'function') {
      const fixed = restFuncs.get(name)
      const ext = extExp.get(name)
      const ie = i64Exp.get(name)
      const hostAbi = hostAbiExp.get(name)
      const release = releases.has(name), flag = flagged.has(name), numeric = numberResult.has(name)
      exports[name] = (...args) => {
        const writeBack = [], mark = enter(flag)
        let returned = false, scalar = !numeric
        try {
          const a = args.slice(0, fixed).map(i64Arg(ie, ext, memWrapVal, hostAbi, name, writeBack))
          while (a.length < fixed) { const i = a.length; a.push(ie && ie.p.has(i) ? UNDEF_NAN : undefined) }
          const restArr = hostAbi?.skip.has(fixed) ? 0n : mem.Array(args.slice(fixed).map(restElemArg(hostAbi, name)))
          a.push(ie && ie.p.has(fixed) ? restArr : i64ToF64(restArr))
          // audit-#8 P1-1 belt-and-braces — see the scalar-module wrapper above.
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
    } else if (typeof fn === 'function') {
      const ext = extExp.get(name)
      const ie = i64Exp.get(name)
      const hostAbi = hostAbiExp.get(name)
      const len = fn.length
      const release = releases.has(name), flag = flagged.has(name), numeric = numberResult.has(name)
      const general = (...args) => {
        if (args.length > len) args.length = len
        while (args.length < len) args.push(undefined)
        const writeBack = [], mark = enter(flag)
        let returned = false, scalar = !numeric
        try {
          const a = args.map(i64Arg(ie, ext, memWrapVal, hostAbi, name, writeBack))
          // audit-#8 P1-1 belt-and-braces — see the scalar-module wrapper above.
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
      // Numbers only, and nothing for the host to release: no copy of an
      // argument, and a frame that gives back what it allocated by itself, or
      // keeps it by the module's own verdict. No call runs around it, which
      // would have to know what it kept; it counts as one that runs (a host
      // function it calls may call back), and one that threw leaves no mark.
      exports[name] = plainLanes(ie, ext, hostAbi) && !asyncMod && !(release && hostReleased.has(name))
        ? crossing(fn, general, (ret) => typeof ret === 'bigint' && !(ie && ie.r) ? ret : readRet(ret), running, ran, hostAbi?.skip) : general
    } else {
      exports[name] = fn
    }
  }
  // An export whose typed slots take other kinds in variants (`v`, hidden
  // exports of the same body) calls the one the arguments fit.
  for (const [name, ie] of i64Exp) {
    if (!ie.v || !exports[name]) continue
    const cands = [name, ...ie.v].filter(n => exports[n])
    exports[name] = kindDispatch(name, cands.map(n => [exports[n], slotsOf(i64Exp.get(n))]))
    for (const n of ie.v) delete exports[n]
  }
  return exports
}

// ── Typed slots: which of an export's variants an argument list fits ────────
// A typed slot's kind, and whether the body stores into it and reads back
// (`k`): there only an argument of the slot's own kind is exact.
// The slots a variant is chosen by: the typed ones. `Array+` marks a slot that may
// be a plain array the body stores into; it takes whatever arrives, as itself.
const slotsOf = (ie) => Object.entries(ie?.t ?? {}).filter(([, t]) => t !== 'Array+').map(([i, t]) => [+i, t.replace('+', ''), ie.k.has(+i)])
const ELEM_NAMES = ['Int8Array', 'Uint8Array', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array']
// The element kind an argument brings: a typed array's own (a host one, or a
// jz buffer by its box), 'Array' for any other object (Array.from reads it as
// an array-like), null for anything else.
const argKind = (x) => {
  if (typeof x === 'bigint' && isBox(x)) {
    const t = type(x), a = aux(x)
    if (t === PTR.ARRAY) return 'Array'
    if (t !== PTR.TYPED || (a & DATA_VIEW_FLAG)) return null
    return a & 16 ? 'BigInt64Array' : a & 32 ? 'Float16Array' : a & 64 ? 'Uint8ClampedArray' : ELEM_NAMES[a & 7]
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

const prepareInterop = (opts) => {
  // the host references of a memory are one table for every module sharing
  // it: an index one module hands out resolves through another's import
  const state = { extMap: opts.memory instanceof WebAssembly.Memory && opts.memory._extMap ? opts.memory._extMap : [null], mem: null }
  opts._interp = opts._interp || {}
  // __ext_* receive NaN-boxed pointers across the env boundary as i64 (BigInt
  // in JS) — see module/collection.js header for rationale. f64 returns are
  // wrapped back to BigInt so the wasm side reinterprets a non-canonicalized
  // bit pattern.
  // A dynamic member op can reach the host with a receiver that is NOT an
  // external handle (extMap[0] is null — e.g. a builtin's placeholder value, or
  // a number that inference couldn't type whose method jz doesn't implement).
  // Without the guard that surfaces as a bare host TypeError ("Cannot read
  // properties of null") — a mystery. Name the actual failure instead.
  const extRecv = (objBig, prop, what) => {
    const obj = state.extMap[offset(objBig)]
    if (obj == null) throw new Error(`'${String(prop)}' — jz dispatched this ${what} to the host, but the receiver is not a host object (an unsupported builtin method, or a receiver type jz couldn't resolve)`)
    return obj
  }
  const readProperty = (objBig, propBig, legacy = false, raw = false) => {
    const prop = state.mem.read(propBig)
    const obj = extRecv(objBig, prop, 'property read')
    const value = obj[prop]
    // (a method reference the receiver lacks: the invoke that follows names it)
    if (raw && typeof value !== 'function') state.methodMiss = { obj, prop }
    if (raw || !legacy && typeof value === 'function') return bits(hostValue(state, value))
    // An explicitly-external BigInt64Array/BigUint64Array still carries exact
    // runtime BigInt evidence (ordinary host values use the typed-memory codec).
    // Box it instead of routing a plain bigint through evidence-free wrapVal.
    // `value` is cached above, so a getter executes exactly once.
    const bigTyped = typeof value === 'bigint' &&
      (obj instanceof BigInt64Array || obj instanceof BigUint64Array)
    const wrapped = bigTyped ? state.mem.BigInt(value)
      : state.mem.wrapVal(legacy && typeof value === 'function' ? value.bind(obj) : value)
    return bits(wrapped)
  }
  // New reads preserve the native container codec but never bind functions.
  // The older import keeps its bound-method behavior for existing binaries.
  opts._interp.__ext_prop = (objBig, propBig) => readProperty(objBig, propBig, true)
  opts._interp.__ext_get = (objBig, propBig) => readProperty(objBig, propBig)
  opts._interp.__ext_has_iterator = objBig => {
    const obj = extRecv(objBig, Symbol.iterator, 'iterator-method test')
    const method = obj[Symbol.iterator]
    return method == null ? 0 : 1
  }
  opts._interp.__ext_is_error = (objBig, kind) => {
    const Ctor = globalThis[ERR_CLASS_NAMES[kind]]
    return state.extMap[offset(objBig)] instanceof Ctor ? 1 : 0
  }
  // JSON.stringify's walker met a host object: the host's text, each line
  // indented to the walker's depth, or undefined where the host writes none.
  opts._interp.__ext_json = (objBig, gapPtr, gapLen, depth) => {
    const obj = extRecv(objBig, 'toJSON', 'serialization')
    const gap = String.fromCharCode(...new Uint16Array(state.mem.buffer, gapPtr, gapLen))
    const text = JSON.stringify(obj, null, gap)
    return text === undefined ? bits(UNDEF_NAN) : bits(state.mem.wrapVal(gap ? text.replace(/\n/g, '\n' + gap.repeat(depth)) : text))
  }
  opts._interp.__ext_json_omits = (objBig) => {
    const obj = state.extMap[offset(objBig)]
    return typeof obj === 'function' || typeof obj === 'symbol' ? 1 : 0
  }
  opts._interp.__ext_enum = (objBig, mode) => {
    const obj = extRecv(objBig, 'keys', 'enumeration')
    return bits(state.mem.wrapVal(mode === 3 ? Reflect.ownKeys(obj) : mode === 0 ? Object.keys(obj) : mode === 1 ? Object.values(obj) : Object.entries(obj)))
  }
  opts._interp.__ext_copy_has = (objBig, propBig) => {
    const prop = state.mem.read(propBig)
    return Object.getOwnPropertyDescriptor(extRecv(objBig, prop, 'property copy'), prop)?.enumerable ? 1 : 0
  }
  opts._interp.__ext_has = (objBig, propBig) => {
    const prop = state.mem.read(propBig)
    return (prop in extRecv(objBig, prop, 'membership test')) ? 1 : 0
  }
  opts._interp.__ext_delete = (objBig, propBig) => {
    const prop = state.mem.read(propBig)
    return Reflect.deleteProperty(extRecv(objBig, prop, 'property deletion'), prop) ? 1 : 0
  }
  opts._interp.__ext_set = (objBig, propBig, valBig) => {
    const v = state.mem.read(valBig, state.fnOf)
    // A typed array (or DataView) the module stores on a host object keeps its
    // identity: the property holds a live view of the module's storage, and a
    // read of it back into the module (wrapVal) is that storage again, so
    // state kept on a host object (`p.state ??= new Float64Array(n)`) carries
    // from call to call as in JS. A view of wasm memory detaches when the
    // memory grows: the host then reads an empty array, and the module still
    // reads its own. The store keeps a pointer into the heap, so the call
    // around it releases nothing (`_kept`, wrap's leave).
    if (ArrayBuffer.isView(v)) { state.mem._views?.set(v, valBig); state.mem._kept = true }
    const prop = state.mem.read(propBig)
    extRecv(objBig, prop, 'property write')[prop] = v
    return 1
  }
  // Raw property Get, shared by reads, copies and method references. Do not
  // bind functions: that changes identity/this and observes name/length.
  opts._interp.__ext_method = (objBig, propBig) => readProperty(objBig, propBig, false, true)
  const invoke = (fn, obj, args) => {
    if (typeof fn !== 'function') {
      const miss = state.methodMiss
      throw new TypeError(miss && miss.obj === obj ? `${String(miss.prop)} is not a function on the host receiver` : 'Host value is not callable')
    }
    const value = Reflect.apply(fn, obj, args)
    const bigTyped = typeof value === 'bigint' &&
      (obj instanceof BigInt64Array || obj instanceof BigUint64Array)
    return hostRet(state, value, bigTyped)
  }
  opts._interp.__ext_invoke = (fnBig, recvBig, argsBig) => invoke(
    state.mem.read(fnBig, state.fnOf), state.mem.read(recvBig, state.fnOf), state.mem.read(argsBig, state.fnOf))
  // Older compiled modules pass receiver/key/arguments to this import. Keep
  // that ABI distinct from the captured callable/receiver/arguments above.
  opts._interp.__ext_call = (objBig, propBig, argsBig) => {
    const prop = state.mem.read(propBig), obj = extRecv(objBig, prop, 'method call')
    const args = state.mem.read(argsBig, state.fnOf)
    return invoke(prop === undefined ? obj : obj[prop], prop === undefined ? undefined : obj, args)
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
  // Web globals (fetch, …): the module imported them because bare calls were
  // lowered by module/web.js — bind from globalThis with full marshalling;
  // thenables adopt into jz promises. opts.imports.env overrides win.
  for (const name of envFns) {
    if (imports.env[name] || !WEB_GLOBALS.has(name)) continue
    const host = globalThis[name]
    if (typeof host !== 'function') continue
    imports.env[name] = (...args) => hostRet(state, host(...args.map(a => state.mem ? state.mem.read(a, state.fnOf) : decode(a, state.fnOf))))
  }
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
      const v = readArgBits(state, valBig)
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
  // Byte-fill entropy for crypto.getRandomValues/randomUUID (module/crypto.js).
  // Fills wasm linear memory directly; the view is created per call — never
  // cached — so a Memory.grow between calls can't leave a detached view.
  if (envFns.has('random') && !imports.env.random) {
    imports.env.random = (off, len) => {
      const view = new Uint8Array(state.mem.buffer, off, len)
      if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(view)
      else for (let i = 0; i < len; i++) view[i] = (Math.random() * 256) >>> 0
    }
  }
  if (envFns.has('hardwareConcurrency') && !imports.env.hardwareConcurrency) {
    imports.env.hardwareConcurrency = () => globalThis.navigator?.hardwareConcurrency ?? 1
  }
  if (envFns.has('parseFloat') && !imports.env.parseFloat) {
    imports.env.parseFloat = (valBig) => {
      const s = readArgBits(state, valBig)
      return parseFloat(s)
    }
  }
  if (envFns.has('parseInt') && !imports.env.parseInt) {
    imports.env.parseInt = (valBig, radix) => {
      const s = readArgBits(state, valBig)
      return parseInt(s, radix || undefined)
    }
  }
  // host: 'js' timer wiring. Wasm calls env.setTimeout/clearTimeout; we call
  // the callback back as any closure the host holds (state.fnOf, read at the
  // first fire: a timer armed by the module's init runs before wrap sets it).
  // Each id maps to a cancel thunk so set/clear share state without tagging.
  // env.setTimeout receives cbPtr as i64 bits (BigInt), see module/timer.js.
  if (envFns.has('setTimeout') || envFns.has('clearTimeout')) {
    const cancel = new Map()
    let nextId = 1
    if (envFns.has('setTimeout') && !imports.env.setTimeout) imports.env.setTimeout = (cbBig, delayMs, repeat) => {
      const id = nextId++
      // after each timer callback: drain microtasks + settle host promises
      // parked on async exports (state.afterTick set by wrap for async modules)
      let cb
      const fire = () => { (cb ??= state.fnOf?.(cbBig))?.(); state.afterTick?.() }
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
  // requestAnimationFrame wiring: real rAF where the host has one; a 16 ms
  // timer elsewhere (Node) so frame-driven modules still run — the callback
  // receives a real timestamp either way.
  if (envFns.has('requestAnimationFrame') || envFns.has('cancelAnimationFrame')) {
    const cancel = new Map()
    let nextId = 1
    if (envFns.has('requestAnimationFrame') && !imports.env.requestAnimationFrame) imports.env.requestAnimationFrame = (cbBig) => {
      const id = nextId++
      const fire = (t) => { cancel.delete(id); state.fnOf?.(cbBig)(t); state.afterTick?.() }
      const raf = globalThis.requestAnimationFrame
      if (typeof raf === 'function') {
        const h = raf(fire)
        cancel.set(id, () => globalThis.cancelAnimationFrame?.(h))
      } else {
        const h = setTimeout(() => fire(typeof performance !== 'undefined' ? performance.now() : Date.now()), 16)
        cancel.set(id, () => clearTimeout(h))
      }
      return id
    }
    if (envFns.has('cancelAnimationFrame') && !imports.env.cancelAnimationFrame) imports.env.cancelAnimationFrame = (id) => {
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
      0x0f, ...Array.from('wasm:js-string', c => c.charCodeAt(0)),             // mod name
      0x06, ...Array.from('length', c => c.charCodeAt(0)),                     // name
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
          // i64 carrier: args arrive as BigInt bits (box) or number; decode with integer
          // ops — never materialize a box as f64. Return the i64 bits of the wrapped result.
          const decoded = args.map(a => state.mem ? state.mem.read(a, state.fnOf) : decode(a, state.fnOf))
          return hostRet(state, fn.call(fns, ...decoded))
        }
    }
  }

  installDefaultEnvImports(mod, imports, state)
  // Shared memory: normalize (auto-wrap raw Memory), pass as import.
  // Numeric opts.memory is a compile-time page count shorthand, not an import.
  if (opts.memory instanceof WebAssembly.Memory) {
    // Auto-wrap raw WebAssembly.Memory → enhanced jz.memory
    if (!_enhanced.has(opts.memory)) opts.memory = memory(opts.memory)
    // A module whose schemas would bind at other ids is rejected here, before
    // its start function and data segments write into the memory it shares
    else mergeTables(opts.memory, moduleTables(mod))
    if (!imports.env) imports.env = {}
    imports.env.memory = opts.memory
  }
  // Auto-imported host globals: provide as WebAssembly.Global wrapping NaN-boxed
  // external refs. Carrier is i64 so the NaN payload survives V8's boundary
  // canonicalization — wasm side reinterprets to f64 (see asF64 in src/ir.js).
  for (const imp of WebAssembly.Module.imports(mod)) {
    if (imp.kind === 'global' && imp.module === 'env') {
      const host = globalThis[imp.name]
      if (!imports.env) imports.env = {}
      // A global this host lacks (`self` in Node, `process` in a browser) is undefined: a
      // library selects its global object by testing them, and the arm it does not take
      // still names the value.
      if (host === undefined) { imports.env[imp.name] = new WebAssembly.Global({ value: 'i64', mutable: false }, UNDEF_NAN); continue }
      let id = state.extMap.indexOf(host); if (id === -1) { id = state.extMap.length; state.extMap.push(host) }
      imports.env[imp.name] = new WebAssembly.Global({ value: 'i64', mutable: false }, ptr(11, 0, id))
    }
  }
  if (WebAssembly.Module.exports(mod).some(e => e.name === '__jz_throw_host')) {
    const wrapped = new Map()
    for (const imp of WebAssembly.Module.imports(mod)) if (imp.kind === 'function') {
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
  // WASI reactor convention: a `host: 'wasi'` module ships its init as the standard
  // `_initialize` export (never a wasm start section — WASI calls there would fire
  // before _setMemory above). Called for ANY module exporting it, imports or not:
  // a hostless wasi module (no console/Date use) still needs its init run. A JS-host
  // module whose init reaches the host (a host global, a member of a host value)
  // ships the same export, called below once its memory is readable.

  // Drive WASM timer queue via JS scheduling (non-blocking, no-op if absent).
  attachTimers(inst)

  // For shared memory, resolve memory from import; for own memory, from export.
  const rawMemory = opts.memory instanceof WebAssembly.Memory ? opts.memory : inst.exports.memory
  const memSrc = { module: mod, instance: inst, exports: { ...inst.exports, memory: rawMemory }, extMap: state.extMap }
  const enhanced = memory(memSrc)
  state.mem = enhanced
  state.raise = inst.exports.__jz_throw_host
  state.errTag = inst.exports.__jz_err
  // Install closure decoding before init too: an initializer can call a host
  // function which synchronously invokes a compiled callback.
  const exports = wrap(memSrc, undefined, state)
  state.flushPrint?.()
  if (inst.exports._initialize) {
    exports._initialize()
    enhanced._markBase?.()
  }
  // A memoryless module keeps a minimal reader internally (state.mem, for decoding
  // its SSO/atom boundary values), but the result's `.memory` stays null — the
  // module genuinely exposes no linear memory. `jz.memory(result)` still hands back
  // a usable reader on demand.
  return { exports, memory: enhanced?.scalar ? null : enhanced, instance: inst, module: mod }
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
/**
 * Compile wasm bytes to a `WebAssembly.Module`, preferring native
 * `wasm:js-string` builtins when the engine honors the option (V8 17+/Safari
 * 18.4+; older engines throw or ignore it — try-fallback handles both). A
 * `WebAssembly.Module` passed in is returned as-is. Factor it out so callers
 * can compile once and instantiate many times without re-validating the bytes
 * (`instantiate(toModule(wasm))` skips the per-call compile on hot loops).
 *
 * @param {Uint8Array|ArrayBuffer|WebAssembly.Module} wasm
 * @returns {WebAssembly.Module}
 */
export const toModule = (wasm) => {
  if (wasm instanceof WebAssembly.Module) return wasm
  if (jssProbeNative()) {
    try { return new WebAssembly.Module(wasm, { builtins: ['js-string'] }) }
    catch { return new WebAssembly.Module(wasm) }
  }
  return new WebAssembly.Module(wasm)
}

export const instantiate = (wasm, opts = {}) => {
  const state = prepareInterop(opts)
  const mod = toModule(wasm)
  const { imports, needsWasi } = buildImports(mod, opts, state)
  const hasImports = Object.keys(imports).some(k => k !== '_setMemory')
  const inst = new WebAssembly.Instance(mod, hasImports ? imports : undefined)
  return finishInstantiation(mod, inst, imports, needsWasi, opts, state)
}
