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
import { HEAP, encodePtrHi, decodePtrType, decodePtrAux, ATOM, ATOM_HI, LAYOUT, BIGINT_SENTINEL_BITS, BIGINT_SENTINEL_VALUE } from './layout.js'
import { ERR_INFO } from './err-codes.js'

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
  const base = heapGlobal ? (heapGlobal.value >>> 0) : HEAP.START
  const alloc = (bytes) => {
    // Align up to 8 without `& ~7` — a JS bitwise op ToInt32-truncates its RESULT too,
    // so `(x + 7) & ~7` would re-introduce the same sign flip past 2 GiB even with a
    // correctly-unsigned `getPtr()`. Plain arithmetic has no such ceiling.
    const ptr = getPtr()
    const aligned = ptr - (ptr % 8)
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
    if (d.getUint32(HEAP.PTR_ADDR, true) < HEAP.START) d.setInt32(HEAP.PTR_ADDR, HEAP.START, true)
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

// NaN-box codec — integer / BigInt based. A box NEVER becomes a JS number: JSC (Safari)
// canonicalizes a NaN payload the instant it materializes as f64 (boundary return,
// Float64Array read, getFloat64), so a box is carried in JS-land as a BigInt (the i64
// bits) and decoded with integer ops. Only genuine (non-NaN) numbers ever touch f64.
const MASK32 = 0xffffffffn
// Reinterpret for GENUINE numbers (and freshly-built boxes leaving JS): `_f64` only ever
// holds a real number here, never a live NaN-box, so there is nothing for JSC to purify.
const _buf = new ArrayBuffer(8), _u32 = new Uint32Array(_buf), _f64 = new Float64Array(_buf)
export const f64ToI64 = (n) => { _f64[0] = n; return (BigInt(_u32[1]) << 32n) | BigInt(_u32[0] >>> 0) }
export const i64ToF64 = (b) => { _u32[0] = Number(b & MASK32); _u32[1] = Number((b >> 32n) & MASK32); return _f64[0] }

const hi32 = (b) => Number((b >> 32n) & MASK32)
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
const isBox = (b) => (hi32(b) & 0xFFF80000) === 0x7FF80000
// i64 bits for a wrapVal result (BigInt box, or number → its f64 bits): memory staging + i64 params.
const bits = (v) => typeof v === 'bigint' ? v : f64ToI64(v)

// Reserved atoms (type=ATOM, offset=0): aux 1/2/4/5 → null/undefined/false/true. BigInt boxes.
export const NULL_NAN = BigInt(ATOM_HI[ATOM.NULL]) << 32n
export const UNDEF_NAN = BigInt(ATOM_HI[ATOM.UNDEF]) << 32n
export const FALSE_NAN = BigInt(ATOM_HI[ATOM.FALSE]) << 32n
export const TRUE_NAN = BigInt(ATOM_HI[ATOM.TRUE]) << 32n

// Coerce JS null/undefined → boxed atom (BigInt); everything else passes through.
export const coerce = v => v === null ? NULL_NAN : v === undefined ? UNDEF_NAN : v

// jz:i64exp `s`-lane decode (present-key BigInt through the census, represented-
// maybe-undefined-design.md §6/§12 Slice 5, the `presentKindUnboxed` family): the
// i64 result is either a genuine raw BigInt, or — when the dict/Map key the census
// traced was absent at runtime — a FIXED sentinel bit pattern whose real JS value
// depends on which operator produced it (a bare read/call-result decays to
// `undefined`; unary `-`/`~` ToNumeric undefined per ES2024 13.5.6/13.5.9, a real
// NUMBER, never `undefined` itself). Neither takes the generic NaN-box `decode`/
// `mem.read` path, which misdecodes a small BigInt's raw i64 bits as a subnormal
// float (the original repro, `5n` reading back `2.5e-323`). Sentinel kinds/bits/
// values are BIGINT_SENTINEL_KIND/BITS/VALUE (layout.js — audit-#11 ABI
// formalization: the ONE table kind.js's censusBigintSentinelKind, this decode,
// and the `jz:i64exp` custom-section `s` field all read, instead of three
// independent copies of the same 4 magic numbers). JOINT_BINARY shares
// UNARY_NEG's bits/value on purpose — both mean "the whole expression resolved
// to Number NaN" (§14 point 4, audit #10's joint runtime-domain dispatch: a
// binary arithmetic node whose BOTH operands independently claim census-BIGINT
// can still resolve Number-domain at runtime when an operand is genuinely
// absent — emit.js's `bigIntJointDispatch` explicitly substitutes canonical NaN
// for an absent operand before computing, rather than trusting WASM's
// arithmetic-NaN-propagation to reproduce that exact bit pattern on its own —
// confirmed NOT guaranteed: `f64.add` of two identical UNDEF_NAN payloads
// returned that SAME tagged bit pattern verbatim on this engine, not a
// canonical NaN, so this table entry only ever matches AFTER that explicit
// substitution). Bitwise ops (&,|,^,<<,>>) sharing JOINT_BINARY have NO working
// sentinel for their OWN "both absent" case — ToInt32(NaN)=0, and 0's bit
// pattern collides with a genuine BigInt 0n, the same permanent, accepted
// single-point-collision class the raw-i64-carrier doctrine already tolerates
// elsewhere — left as a documented narrow gap, not fixed here.
const decodeBigintSentinel = (ret, s) => ret === BIGINT_SENTINEL_BITS[s] ? BIGINT_SENTINEL_VALUE[s] : ret

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
export const ptr = (type, aux, offset) => (BigInt(encodePtrHi(type, aux)) << 32n) | BigInt(offset >>> 0)
export const offset = (p) => Number(asBits(p) & MASK32)
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

// Memory-free decode of an i64-bits boundary value: numbers pass through, a box becomes
// its atom / SSO string. Exactly the forms a *memoryless* module can carry (no linear
// memory → no heap string/array/object). Heap-carrying modules route through `mem.read`.
const decode = v => {
  if (Array.isArray(v)) return v.map(decode)   // multi-value tuple — each lane is an i64-carrier (memoryless)
  if (typeof v === 'number') { if (v === v) return v; v = f64ToI64(v) }  // f64 NaN-box (intact on V8) → bits
  else if (typeof v !== 'bigint') return v     // already-decoded JS value
  if (!isBox(v)) return i64ToF64(v)            // non-NaN bits → number
  if (type(v) === 4 && (aux(v) & LAYOUT.SSO_BIT)) return decodeSSO(v)
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
  // flag-carrying kinds: elemId = base code | flag (32 = f16, 64 = clamped)
  Float16Array: [35, 2, 'getFloat16', 'setFloat16'],
  Uint8ClampedArray: [65, 1, 'getUint8', 'setUint8'],
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
    // Memoryless module (SSO strings / atoms / numbers only — no linear memory):
    // hand back a minimal reader instead of null so callers can still decode its
    // boundary values from bits. `read`/`wrapVal` cover the value forms that exist
    // without memory; `scalar` flags the fast path that skips heap marshaling.
    if (!mem) return { read: decode, wrapVal: coerce, scalar: true }
    wasmExports = { ...raw, memory: mem }
    extMap = src.extMap || null
    mod = src.module || null
  }

  const dv = () => new DataView(mem.buffer)

  // Allocator scaffold: bumps the exported `$__heap` global (or memory[1020] for
  // shared memory). Wasm `_alloc` takes over when exported; `_clear`/jsReset rewinds.
  const { alloc: jsAlloc, reset: jsReset, initHeapPtr } = makeJsAllocator(mem, wasmExports?.__heap)
  // `_alloc`'s i32 result crosses the wasm→JS boundary SIGNED (same ToInt32 rule as any
  // other i32 — see makeJsAllocator's comment); `>>> 0` restores the true unsigned address
  // once the heap grows past 2 GiB, matching jsAlloc's own already-unsigned return.
  const wasmAlloc = wasmExports?._alloc && (bytes => wasmExports._alloc(bytes) >>> 0)
  let alloc = wasmAlloc || jsAlloc
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

  // Read the Error-class sid→name map (audit-#9 P0-2 brand redesign — class
  // identity lives in the schema id, not a decodable slot, so decodeThrown
  // below needs this table to recover which ECMAScript class a decoded Error
  // object's sid came from). Same merge discipline as `schemas` above: a sid
  // already known (from a prior enhance of this memory) wins — first module's
  // numbering is authoritative.
  const errorSidToClass = mem.errorSidToClass || new Map()
  const errClsBytes = mod && customSection(mod, 'jz:errcls')
  if (errClsBytes) {
    const r = sectionReader(errClsBytes)
    const n = r.varint()
    for (let j = 0; j < n; j++) {
      const sid = r.varint(), name = r.str(r.varint())
      if (!errorSidToClass.has(sid)) errorSidToClass.set(sid, name)
    }
  }

  // If already enhanced, just update bindings (new module compiled into same memory)
  if (_enhanced.has(mem)) {
    mem.schemas = schemas
    mem.errorSidToClass = errorSidToClass
    if (wasmAlloc) { alloc = wasmAlloc; mem.alloc = alloc }
    mem.reset = jsReset   // post-init rewind — see the note at the first-enhance path
    if (extMap) mem._extMap = extMap
    return mem
  }

  // Patch methods onto the Memory instance
  mem.schemas = schemas
  mem.errorSidToClass = errorSidToClass
  mem._extMap = extMap

  mem.Array = (data) => {
    const n = data.length, off = hdr(n, n, n * 8)
    // Stage as i64 bits, not as JS Numbers: V8 may transition a JS Array holding
    // NaN-payload doubles to HOLEY_DOUBLE_ELEMENTS, which canonicalizes the NaN
    // payload to 0x7FF8000000000000 — destroying the type/offset bits.
    const wrapped = new BigInt64Array(n)
    for (let i = 0; i < n; i++) wrapped[i] = bits(mem.wrapVal(data[i]))
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
    const enc = TEXT_ENC.encode(str)
    const n = enc.length, raw = alloc(4 + n), m = dv()
    m.setInt32(raw, n, true)
    const off = raw + 4
    enc.forEach((b, i) => m.setUint8(off + i, b))
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
    if (typeof v === 'number' || typeof v === 'boolean') return Number(v)
    if (typeof v === 'string') return mem.String(v)
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

  // First-class jz HASH from a plain JS object — the schema-less marshal. Builds the
  // kernel's exact open-addressed table ([seq<<32|hash:i64][key:f64][val:f64] × cap,
  // home slot = hash & (cap-1), linear probe, len/cap header at -8/-4) so every
  // wasm-side dyn op — reads, writes, NEW props, growth, delete, iteration — runs
  // natively with stable identity. The External reflection path decodes/re-marshals
  // per access, so nested container mutation (`params.P[i][j] = …`) lands on
  // marshaling copies and silently vanishes — a params-bag must be a real hash.
  // Hash twins of module/collection.js (clampHash / ssoMix / byteFnv) — MUST agree
  // with __str_hash or wasm probes start at the wrong home slot and miss.
  const clampHash = (h) => (h <= 1 ? (h + 2) | 0 : h)
  const jzStrHash = (box) => {
    const b = bits(box)
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
    for (let i = 0; i < len; i++) h = Math.imul(h ^ m.getUint8(off + i), 0x01000193) | 0
    return clampHash(h) >>> 0
  }
  mem.Hash = function(obj) {
    const entries = Object.entries(obj)
    let cap = 8
    while (entries.length * 4 >= cap * 3) cap <<= 1   // stay under the 75% grow trigger
    // cap × (24-B entry + 4-B probe hash lane) — collection.js's exact layout;
    // the lane (after the entries) is what wasm probes walk
    const off = hdr(entries.length, cap, cap * 28)
    // Stage every slot as i64 bits (empty = 0) — same NaN-canonicalization dodge as mem.Array.
    const staged = new BigInt64Array(cap * 3)
    const lane = new Int32Array(cap)
    entries.forEach(([k, v], seq) => {
      const keyBox = mem.String(k)
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
      else return mem.Hash(obj)   // no compiled schema: first-class hash (External loses nested-mutation identity)
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
      wrapped[i] = bits(v)
    }
    const dst = new BigInt64Array(mem.buffer, raw, n)
    for (let i = 0; i < n; i++) dst[i] = wrapped[i]
    return ptr(6, sid, raw)
  }

  mem.read = function(p) {
    if (Array.isArray(p)) return p.map(v => mem.read(v))  // multi-value tuple
    if (typeof p === 'number') {
      if (p === p) return p              // genuine number passthrough (NaN fails ===)
      p = f64ToI64(p)                    // f64 NaN-box (intact on V8) → bits; decode below
    } else if (typeof p !== 'bigint') {
      return p                           // already a decoded JS value (string/object/…) — passthrough
    }
    // p is now i64 bits (BigInt). Decode with integer ops — never materialize as f64.
    if (!isBox(p)) return i64ToF64(p)    // non-NaN bits → genuine number
    const m = dv(), t = type(p), a = aux(p), off = offset(p)
    if (t === 0 && off === 0) {
      if (a === 1) return null
      if (a === 2) return undefined
      if (a === 4) return false
      if (a === 5) return true
    }
    if (t === 11 && mem._extMap) return mem._extMap[off]
    if (t === 1) {  // ARRAY
      let aOff = off
      // Follow forwarding pointers (cap === -1 means array was reallocated)
      while (m.getInt32(aOff - 4, true) === -1) aOff = m.getInt32(aOff - 8, true)
      const len = m.getInt32(aOff - 8, true), out = new Array(len)
      for (let i = 0; i < len; i++) out[i] = mem.read(m.getBigInt64(aOff + i * 8, true))
      return out
    }
    if (t === 3) {  // TYPED
      const elem = a & 7
      const [, stride] = ELEM_BY_ID[elem]
      const Ctor = (a & 32)
        ? (globalThis.Float16Array ?? (() => { throw new Error('decoding a Float16Array result needs a host with Float16Array (Node ≥ 24 / modern browsers)') })())
        : (a & 64) ? Uint8ClampedArray
        : [Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array][elem]
      if (a & 8) {
        const byteLen = m.getInt32(off, true), dataOff = m.getInt32(off + 4, true)
        return new Ctor(mem.buffer, dataOff, byteLen / stride)
      }
      const byteLen = m.getInt32(off - 8, true)
      return new Ctor(mem.buffer, off, byteLen / stride)
    }
    if (t === 2) {  // BUFFER
      const byteLen = m.getInt32(off - 8, true)
      const out = new ArrayBuffer(byteLen)
      new Uint8Array(out).set(new Uint8Array(mem.buffer, off, byteLen))
      return out
    }
    if (t === 4) {  // STRING (aux SSO_BIT = inline, else heap)
      if (a & LAYOUT.SSO_BIT) return decodeSSO(p)
      const len = m.getInt32(off - 4, true)
      return TEXT_DEC.decode(new Uint8Array(mem.buffer, off, len))
    }
    // CARRIER PROGRAM Slice 3 — registry-derived 'interop-decode' arm
    // (layout-kinds.js KIND_REGISTRY.BIGINT / FINDINGS[interop-decode]): the
    // box's 8-byte payload cell IS the BigInt's raw two's-complement i64 —
    // no header, no aux, read it back as a real host bigint. Distinct from
    // decodeBigintSentinel above (a DIFFERENT, already-shipped mechanism for
    // the raw-i64 jz:i64exp lane's own absent-key encoding, not this boxed-
    // pointer path).
    if (t === 5) return m.getBigInt64(off, true)  // BIGINT
    if (t === 6) {  // OBJECT
      const keys = mem.schemas[a]
      if (!keys) return p
      const obj = {}
      for (let i = 0; i < keys.length; i++) obj[keys[i]] = mem.read(m.getBigInt64(off + i * 8, true))
      return obj
    }
    if (t === 7) {  // HASH
      const size = m.getInt32(off - 8, true), cap = m.getInt32(off - 4, true), obj = {}
      for (let i = 0, found = 0; i < cap && found < size; i++) {
        if (m.getBigInt64(off + i * 24, true) !== 0n) {
          obj[mem.read(m.getBigInt64(off + i * 24 + 8, true))] = mem.read(m.getBigInt64(off + i * 24 + 16, true))
          found++
        }
      }
      return obj
    }
    if (t === 8) {  // SET
      const size = m.getInt32(off - 8, true), cap = m.getInt32(off - 4, true), set = new Set()
      for (let i = 0; i < cap && set.size < size; i++)
        if (m.getBigInt64(off + i * 16, true) !== 0n) set.add(mem.read(m.getBigInt64(off + i * 16 + 8, true)))
      return set
    }
    if (t === 9) {  // MAP
      const size = m.getInt32(off - 8, true), cap = m.getInt32(off - 4, true), map = new Map()
      for (let i = 0; i < cap && map.size < size; i++)
        if (m.getBigInt64(off + i * 24, true) !== 0n)
          map.set(mem.read(m.getBigInt64(off + i * 24 + 8, true)), mem.read(m.getBigInt64(off + i * 24 + 16, true)))
      return map
    }
    return i64ToF64(p)  // canonical NaN-number / CLOSURE / unknown — reinterpret to f64
  }

  mem.write = function(p, data) {
    const t = type(p), off = offset(p), m = dv()
    if (t === 1) {
      const cap = m.getInt32(off - 4, true)
      if (data.length > cap) throw Error(`write: ${data.length} exceeds capacity ${cap}`)
      m.setInt32(off - 8, data.length, true)
      for (let i = 0; i < data.length; i++) m.setBigInt64(off + i * 8, bits(coerce(data[i])), true)
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
        if (i >= 0) m.setBigInt64(off + i * 8, bits(coerce(data[k])), true)
      }
    } else {
      throw Error(`write: unsupported type ${t}`)
    }
  }

  mem.alloc = alloc
  // Rewind to the JS-captured post-init heap mark, NOT the wasm `_clear` (which
  // rewinds to the static-data end and would clobber module-global heap values —
  // a top-level `let o = {…}` — on the first alloc after reset). `jsReset`'s base
  // is `$__heap` read after instantiation (start ran), i.e. exactly the high-water
  // mark above all module-init allocations. Both share `$__heap`, so a wasm `_alloc`
  // and this reset stay consistent. (Shared memory has no `$__heap` global → base
  // is the fixed start, preserving prior behavior.)
  mem.reset = jsReset

  // TypedArray constructors: memory.Float64Array(data), etc.
  // Bulk-copy path: when input is a TypedArray whose element type matches
  // the target (same stride), use .set() for a fast memcpy instead of
  // per-element DataView writes. Falls back to DataView for mismatched types.
  const TA = [Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array]
  TA[65] = Uint8ClampedArray
  if (globalThis.Float16Array) TA[35] = globalThis.Float16Array
  for (const [name, [elemId, stride, , setter]] of Object.entries(ELEMS)) {
    mem[name] = (data) => {
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
    if (!meta) throw Error(`allocTyped: unsupported type ${Ctor?.name ?? Ctor}`)
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
  // i64-carrier map: per export, which param positions ride i64 (BigInt) and whether the
  // result does. The boxed (NaN-box) carrier crosses as i64 so JSC can't canonicalize the
  // payload; we reinterpret BigInt↔f64 by bits at exactly those positions. A bigint result
  // has no entry — its BigInt already IS the value. `s` (represented-maybe-undefined-
  // design.md §6/§12 Slice 5): a census-BIGINT sentinel result — same raw i64 bits as a
  // plain bigint result UNLESS the underlying dict/Map key was absent at runtime, in which
  // case the bits equal the sentinel kind's fixed pattern (decodeBigintSentinel above).
  // (Mirror of the test/data.js adapter.)
  const i64Exp = new Map()
  const i64Bytes = customSection(mod, 'jz:i64exp')
  if (i64Bytes) {
    try { for (const e of JSON.parse(td.decode(i64Bytes))) i64Exp.set(e.name, { p: new Set(e.p || []), r: !!e.r, s: e.s || 0 }) }
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
  // sole content). `rest` = truthy only when the plan can prove bigint
  // evidence for this export's rest-parameter elements (never true today —
  // no evidence source exists for host-populated rest elements). A slot in
  // neither `raw` nor `tag` has no evidence of any kind: i64Arg (below)
  // rejects a plain bigint there instead of guessing from the absence.
  const hostAbiExp = new Map()
  const hostAbiBytes = customSection(mod, 'jz:hostabi')
  if (hostAbiBytes) {
    try {
      for (const e of JSON.parse(td.decode(hostAbiBytes)))
        hostAbiExp.set(e.name, { raw: new Set(e.raw || []), tag: new Set(e.tag || []), rest: !!e.rest })
    } catch { /* ignore */ }
  }
  const mem = memory(memSrc)
  // Async boundary: a module compiled from async source exports __mt_drain /
  // __p_state / __p_value (the jzify-injected runtime). Every export call ends
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
    const decoded = mem.read(r)
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
    const value = mem ? mem.read(errBits) : decode(errBits)
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
      if (errClassName != null) {
        const Ctor = globalThis[errClassName] ?? Error
        const wrapped = new Ctor(value.message)
        wrapped.cause = error
        wrapped.thrown = value
        throw wrapped
      }
    }
    // A plain NUMBER matching the $__jz_err code registry (src/err-codes.js) is a
    // jz-internal runtime throw (bounds/coercion/parse — piece 1's per-site codes,
    // fs.js's real errno is NOT in the registry and falls to the generic branch
    // below); resolve it to the real ECMAScript error class it models — a genuine
    // `instanceof SyntaxError`/`TypeError`/etc., not a generic Error with a
    // prefixed message. `wrapped.thrown` always keeps the ORIGINAL code — an
    // in-wasm catch (or a caller inspecting `.thrown`) still sees the raw number,
    // undecoded.
    const info = typeof value === 'number' ? ERR_INFO[value] : undefined
    const Ctor = info ? (globalThis[info.name] ?? Error) : Error
    const wrapped = info ? new Ctor(info.message)
      : new Error(typeof value === 'string' ? value : String(value))
    wrapped.cause = error
    wrapped.thrown = value
    throw wrapped
  }
  const exports = {}
  // Wrap one positional arg. Externref slots (jsstring carrier) pass the JS
  // value straight through — `mem.wrapVal` would NaN-box it — substituting a
  // jsstring literal default for a missing arg. Every other slot marshals via
  // `box`: `coerce` for pure-scalar modules, `mem.wrapVal` for heap modules.
  const wrapArgAt = (ext, i, x, box) =>
    ext?.has(i) ? (x === undefined && ext.def?.has(i) ? ext.def.get(i) : x) : box(x)
  // Per-position arg marshaller: box the value, then for an i64-carrier param (per
  // jz:i64exp) pass its i64 bits (a boxed value is already a BigInt; a numeric arg to a
  // dynamic i64 param → its f64 bits). The box never materializes as f64, so JSC can't
  // canonicalize it. Numeric/externref positions keep their f64/externref carrier.
  const i64Arg = (ie, ext, box, hostAbi, name) => (x, i) => {
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
    //     wasm dispatches by tag (the one reachable evidenced state).
    //   - neither: no BigInt evidence of any kind — the legacy decimal-
    //     string accident only "worked" for typeof-guarded normalization
    //     params and silently garbled every numeric one (the dyn-keys
    //     zero-evidence pin) — refuses loudly with both remedies named
    //     instead.
    let w
    if (typeof x === 'bigint' && !isBox(x)) {
      if (hostAbi?.raw?.has(i)) w = x
      else if (hostAbi?.tag?.has(i)) w = mem.BigInt(x)
      else throw new TypeError(`jz: BigInt argument at param ${i} of ${name}() has no BigInt evidence in the compiled program — give the parameter a provable BigInt path (it then takes the tagged ingress), or pass a decimal string to a typeof-guarded normalizing parameter`)
    } else {
      w = wrapArgAt(ext, i, x, box)
    }
    if (ie && ie.p.has(i)) {
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
      // independent of whatever coerce/wrapVal did to it. A plain (non-i64)
      // f64 numeric slot is untouched: the WebAssembly JS-API's own ToNumber
      // on a raw boolean argument already gives the correct 1/0 there (see the
      // `typeof w === 'bigint' ? i64ToF64(w) : w` fallback below), so a proven-
      // numeric export's `f(true)` keeps working via that native coercion.
      if (typeof x === 'boolean') return x ? TRUE_NAN : FALSE_NAN
      // i64-carrier slot: a string that coerce() left raw (scalar/memoryless module)
      // must be NaN-box encoded. SSO handles ≤6 ASCII chars without heap memory; longer
      // or non-ASCII strings need a heap that this module lacks — throw clearly.
      if (typeof w === 'string') {
        if (w.length > 6 || !/^[\x00-\x7f]*$/.test(w))
          throw new Error('jz: string arg too long or non-ASCII for memoryless module — compile with a string operation to enable heap marshaling')
        return encodeSSO(w)
      }
      return bits(w)                                   // i64 param: pass the box bits
    }
    // f64 position: a box (BigInt) must reinterpret to f64. Happens for an un-wrapped export
    // (e.g. a multi-value result skips wrapping) whose boxed param keeps the legacy f64 carrier
    // — intact on V8; that path is inherently JSC-limited for boxed lanes anyway.
    return typeof w === 'bigint' ? i64ToF64(w) : w
  }

  // Pure scalar module (no memory): pass f64 values directly, no marshaling
  if (!mem || mem.scalar) {
    for (const [name, fn] of Object.entries(realInst.exports)) {
      if (typeof fn !== 'function') { exports[name] = fn; continue }
      const ext = extExp.get(name)
      const ie = i64Exp.get(name)
      const hostAbi = hostAbiExp.get(name)
      const len = fn.length
      exports[name] = (...args) => {
        while (args.length < len) args.push(undefined)
        // audit-#8 P1-1 belt-and-braces: decodeThrown already consumes the marker
        // on every decode, and every in-wasm catch/finally now consumes it too
        // (src/compile/emit.js) — this is defense-in-depth against a raw-instance
        // reuse or any as-yet-unknown in-wasm path that misses that consume, so a
        // fresh call never starts with a stale marker from a PRIOR call.
        if (lastErrBitsWritable) lastErrBits.value = 0n
        try {
          const ret = fn(...args.map(i64Arg(ie, ext, coerce, hostAbi, name)))
          // A bigint-value result returns raw; the `s` lane (census-BIGINT sentinel) decodes
          // only its own fixed sentinel bit pattern; everything else (a boxed i64 result or an
          // f64/number result) takes the generic decode.
          if (typeof ret === 'bigint') {
            if (ie && ie.s) return decodeBigintSentinel(ret, ie.s)
            if (!(ie && ie.r)) return ret
          }
          return decode(ret)
        } catch (e) { decodeThrown(e) }
      }
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
    if (restFuncs.has(name) && typeof fn === 'function') {
      const fixed = restFuncs.get(name)
      const ext = extExp.get(name)
      const ie = i64Exp.get(name)
      const hostAbi = hostAbiExp.get(name)
      exports[name] = (...args) => {
        const a = args.slice(0, fixed).map(i64Arg(ie, ext, memWrapVal, hostAbi, name))
        while (a.length < fixed) { const i = a.length; a.push(ie && ie.p.has(i) ? UNDEF_NAN : i64ToF64(UNDEF_NAN)) }
        const restArr = mem.Array(args.slice(fixed).map(restElemArg(hostAbi, name)))   // BigInt box (i64 carrier)
        a.push(ie && ie.p.has(fixed) ? restArr : i64ToF64(restArr))
        // audit-#8 P1-1 belt-and-braces — see the scalar-module wrapper above.
        if (lastErrBitsWritable) lastErrBits.value = 0n
        try {
          const ret = fn.apply(null, a)
          if (typeof ret === 'bigint') {
            if (ie && ie.s) return decodeBigintSentinel(ret, ie.s)
            if (!(ie && ie.r)) return ret
          }
          return finishRet(ret, readRet)
        } catch (error) {
          decodeThrown(error)
        }
      }
    } else if (typeof fn === 'function') {
      const ext = extExp.get(name)
      const ie = i64Exp.get(name)
      const hostAbi = hostAbiExp.get(name)
      const len = fn.length
      exports[name] = (...args) => {
        while (args.length < len) args.push(undefined)
        // audit-#8 P1-1 belt-and-braces — see the scalar-module wrapper above.
        if (lastErrBitsWritable) lastErrBits.value = 0n
        try {
          const ret = fn.apply(null, args.map(i64Arg(ie, ext, memWrapVal, hostAbi, name)))
          if (typeof ret === 'bigint') {
            if (ie && ie.s) return decodeBigintSentinel(ret, ie.s)
            if (!(ie && ie.r)) return ret
          }
          return finishRet(ret, readRet)
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

// Host-call return marshalling shared by opts.imports wrappers, __ext_call and
// the auto-wired web globals: a thenable becomes a jz promise (awaitable in
// the module — settled via the async runtime's exports, then drain + sweep);
// everything else boxes through wrapVal.
const hostRet = (state, ret) => {
  if (ret != null && typeof ret.then === 'function' && state.pmake) {
    const praw = state.pmake()
    const box = (v) => bits(state.mem ? state.mem.wrapVal(v) : coerce(v))
    ret.then(
      (v) => { state.pfinish(praw, 1, box(v)); state.afterTick?.() },
      (e) => { state.pfinish(praw, 2, box(e instanceof Error ? e.message : e)); state.afterTick?.() })
    return typeof praw === 'bigint' ? praw : bits(praw)
  }
  return bits(state.mem ? state.mem.wrapVal(ret) : coerce(ret))
}

// Callable web globals auto-wired from globalThis when the module imports them
// (module/web.js lowers bare `fetch(...)` etc. to env imports under host:'js').
const WEB_GLOBALS = new Set(['fetch'])

const prepareInterop = (opts) => {
  const state = { extMap: [null], mem: null }
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
    if (obj == null) throw new Error(`'${prop}' — jz dispatched this ${what} to the host, but the receiver is not a host object (an unsupported builtin method, or a receiver type jz couldn't resolve)`)
    return obj
  }
  opts._interp.__ext_prop = (objBig, propBig) => {
    const prop = state.mem.read(propBig)
    const obj = extRecv(objBig, prop, 'property read')
    return bits(state.mem.wrapVal(typeof obj[prop] === 'function' ? obj[prop].bind(obj) : obj[prop]))
  }
  opts._interp.__ext_has = (objBig, propBig) => {
    const prop = state.mem.read(propBig)
    return (prop in extRecv(objBig, prop, 'membership test')) ? 1 : 0
  }
  opts._interp.__ext_set = (objBig, propBig, valBig) => {
    let v = state.mem.read(valBig)
    // A TYPED value decodes to a LIVE VIEW into wasm's own linear memory
    // (mem.read's t===3 branch: `new Ctor(mem.buffer, off, len)`) — sound for
    // a value read-and-immediately-consumed inside one host call, but a host
    // OBJECT PROPERTY is real, persistent JS state: any later Memory.grow()
    // (the bump allocator never frees, so any sufficiently long-running
    // program eventually grows) detaches/reallocates `mem.buffer`, silently
    // invalidating every such view still held on the host side — the next
    // access throws "detached ArrayBuffer" (or, for a stale non-typed read,
    // would silently read zeros). A host object is host-owned persistent
    // state: store an independent copy. `.slice()` is TypedArray's native
    // same-ctor copy — exactly `new Ctor(view)` with no manual size/offset
    // bookkeeping — and a no-op for every other decoded value shape.
    if (ArrayBuffer.isView(v)) v = v.slice()
    const prop = state.mem.read(propBig)
    extRecv(objBig, prop, 'property write')[prop] = v
    return 1
  }
  opts._interp.__ext_call = (objBig, propBig, argsBig) => {
    const prop = state.mem.read(propBig)
    const obj = extRecv(objBig, prop, 'method call')
    const args = state.mem.read(argsBig)
    if (typeof obj[prop] !== 'function')
      throw new Error(`'${prop}' is not a function on this host ${obj?.constructor?.name ?? 'object'}`)
    return hostRet(state, obj[prop].apply(obj, args))
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
    imports.env[name] = (...args) => hostRet(state, host(...args.map(a => state.mem ? state.mem.read(a) : decode(a))))
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
      // after each timer callback: drain microtasks + settle host promises
      // parked on async exports (state.afterTick set by wrap for async modules)
      const fire = () => { state.invoke?.(cbBig); state.afterTick?.() }
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
  // receives a real timestamp either way via __invoke_closure1.
  if (envFns.has('requestAnimationFrame') || envFns.has('cancelAnimationFrame')) {
    const cancel = new Map()
    let nextId = 1
    if (envFns.has('requestAnimationFrame') && !imports.env.requestAnimationFrame) imports.env.requestAnimationFrame = (cbBig) => {
      const id = nextId++
      const fire = (t) => { cancel.delete(id); state.invoke1?.(cbBig, t); state.afterTick?.() }
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
          // i64 carrier: args arrive as BigInt bits (box) or number; decode with integer
          // ops — never materialize a box as f64. Return the i64 bits of the wrapped result.
          const decoded = args.map(a => state.mem ? state.mem.read(a) : decode(a))
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
        imports.env[imp.name] = new WebAssembly.Global({ value: 'i64', mutable: false }, ptr(11, 0, id))
      }
    }
  }
  return { imports, needsWasi }
}

const finishInstantiation = (mod, inst, imports, needsWasi, opts, state) => {
  if (needsWasi) imports._setMemory(inst.exports.memory)
  // WASI reactor convention: a `host: 'wasi'` module ships its init as the standard
  // `_initialize` export (never a wasm start section — WASI calls there would fire
  // before _setMemory above). Called for ANY module exporting it, imports or not:
  // a hostless wasi module (no console/Date use) still needs its init run.
  inst.exports._initialize?.()

  // Trampoline used by env.setTimeout/clearTimeout to fire scheduled closures.
  state.invoke = inst.exports.__invoke_closure || null
  // One-arg variant — env.requestAnimationFrame passes the frame timestamp.
  state.invoke1 = inst.exports.__invoke_closure1 || null

  // Drive WASM timer queue via JS scheduling (non-blocking, no-op if absent).
  attachTimers(inst)

  // For shared memory, resolve memory from import; for own memory, from export.
  const rawMemory = opts.memory instanceof WebAssembly.Memory ? opts.memory : inst.exports.memory
  const memSrc = { module: mod, instance: inst, exports: { ...inst.exports, memory: rawMemory }, extMap: state.extMap }
  const enhanced = memory(memSrc)
  state.mem = enhanced
  state.flushPrint?.()
  // A memoryless module keeps a minimal reader internally (state.mem, for decoding
  // its SSO/atom boundary values), but the result's `.memory` stays null — the
  // module genuinely exposes no linear memory. `jz.memory(result)` still hands back
  // a usable reader on demand.
  return { exports: wrap(memSrc, undefined, state), memory: enhanced?.scalar ? null : enhanced, instance: inst, module: mod }
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
