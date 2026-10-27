/** Static data and shared string pools contain bytes, never JS text. */
import { ctx } from './ctx.js'
import { LAYOUT, PTR } from '../layout.js'

const joinBytes = (parts, len) => {
  if (parts.length === 1) return parts[0]
  const bytes = new Uint8Array(len)
  let off = 0
  for (const part of parts) { bytes.set(part, off); off += part.length }
  return bytes
}

/** Append-only chunks are owned by the accumulator after insertion. */
export const dataPush = (bytes) => {
  ctx.runtime.dataParts.push(bytes)
  ctx.runtime.dataLen += bytes.length
}
export const dataLen = () => ctx.runtime.dataLen
export const dataAlign = (align) => {
  const pad = (align - (dataLen() % align)) % align
  if (pad) dataPush(new Uint8Array(pad))
}
export const dataBytes = () => {
  const r = ctx.runtime
  const bytes = joinBytes(r.dataParts, r.dataLen)
  r.dataParts = bytes.length ? [bytes] : []
  return bytes
}
export const dataReset = (bytes) => {
  ctx.runtime.dataParts = bytes.length ? [bytes] : []
  ctx.runtime.dataLen = bytes.length
}

/** A literal the program lays out in the data segment (a string, an array, an
 *  object, a table): its bytes [start, end), and `leaf` where they never hold
 *  the address of another literal (a string's). The late data strip
 *  (optimize/watr-tail.js stripDeadLateData) drops the bytes of a literal no
 *  surviving code or data names. Flat triples, in data-segment coordinates. */
export const dataRecord = (start, end, leaf) => { ctx.runtime.dataRecords.push(start, end, leaf ? 1 : 0) }
/** Keep the segment's first `n` bytes: a literal past them is gone. */
export const dataTruncate = (n) => {
  dataReset(dataBytes().slice(0, n))
  const recs = ctx.runtime.dataRecords, kept = []
  for (let i = 0; i < recs.length; i += 3) if (recs[i + 1] <= n) kept.push(recs[i], recs[i + 1], recs[i + 2])
  ctx.runtime.dataRecords = kept
}
/** Drop the segment's first `n` bytes: every literal after them moves down by `n`. */
export const dataDropPrefix = (n) => {
  dataReset(dataBytes().slice(n))
  const recs = ctx.runtime.dataRecords, kept = []
  for (let i = 0; i < recs.length; i += 3) if (recs[i] >= n) kept.push(recs[i] - n, recs[i + 1] - n, recs[i + 2])
  ctx.runtime.dataRecords = kept
}

/** Decode static table literals directly to bytes. */
export const hexBytes = (hex) => {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    const a = hex.charCodeAt(i * 2), b = hex.charCodeAt(i * 2 + 1)
    bytes[i] = ((a & 15) + (a > 57 ? 9 : 0)) << 4 | (b & 15) + (b > 57 ? 9 : 0)
  }
  return bytes
}

/** Append `slots` ('0x'+16-hex bit strings) 8-byte aligned, return the raw
 *  byte offset of the first slot. NaN-boxed-pointer-looking slots are recorded
 *  in `ctx.runtime.staticPtrSlots` for the prefix-strip pass. Writes go
 *  through u32 halves — DataView's BigInt accessors are unfaithful in the
 *  self-compiled kernel. */
export function pushStaticSlots(slots, headerBytes = 0) {
  dataAlign(8)
  const off = dataLen()
  const u8 = new Uint8Array(headerBytes + slots.length * 8)
  const dv = new DataView(u8.buffer)
  for (let i = 0; i < slots.length; i++) {
    const h = slots[i]
    dv.setUint32(headerBytes + i * 8, parseInt(h.slice(10), 16) >>> 0, true)
    dv.setUint32(headerBytes + i * 8 + 4, parseInt(h.slice(2, 10), 16) >>> 0, true)
  }
  dataPush(u8)
  if (!ctx.runtime.staticPtrSlots) ctx.runtime.staticPtrSlots = []
  for (let i = 0; i < slots.length; i++) {
    if ((parseInt(slots[i].slice(2, 6), 16) & 0xFFF8) === LAYOUT.NAN_PREFIX) {
      ctx.runtime.staticPtrSlots.push(off + i * 8)
    }
  }
  return off
}

/** Shared-memory string records use the same byte representation. */
export const strPoolPush = (bytes) => {
  const r = ctx.runtime, off = r.strPoolLen
  r.strPoolParts.push(bytes)
  r.strPoolLen += bytes.length
  return off
}
export const strPoolLen = () => ctx.runtime.strPoolLen
export const strPoolBytes = () => {
  const r = ctx.runtime
  const bytes = joinBytes(r.strPoolParts, r.strPoolLen)
  r.strPoolParts = bytes.length ? [bytes] : []
  return bytes
}

const WORD = 4294967296

// Literals are read where they lie, a character at a time: the hosted compiler
// frees nothing within a compile, and a whole module's constants pass through
// here, so no string is made on the way (a slice per constant ran the
// self-compile out of memory).
const hexDigit = (c) => c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1

/** A half of the 64-bit word the last sixteen hex digits of `s` from `from`
 *  spell: the high 32 bits where `high`, else the low. -1 where a character is no digit. */
export function hexHalf(s, from, high) {
  let w = 0, place = 1, n = 0
  for (let i = s.length - 1; i >= from; i--) {
    const c = s.charCodeAt(i)
    if (c === 95) continue
    const d = hexDigit(c)
    if (d < 0) return -1
    if (high ? n >= 8 && n < 16 : n < 8) { w += d * place; place *= 16 }
    n++
  }
  return w
}

/** The low word of the signed integer `s` spells from `from` (decimal or hex): -1 for none. */
const wordAt = (s, from) => {
  let i = from, neg = false
  const sign = s.charCodeAt(i)
  if (sign === 45 || sign === 43) { neg = sign === 45; i++ }
  let r = 0
  if (s.charCodeAt(i + 1) === 120 || s.charCodeAt(i + 1) === 88) {
    r = hexHalf(s, i + 2, false)
    if (r < 0) return -1
  } else for (; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 95) continue
    const d = c - 48
    if (d < 0 || d > 9) return -1
    r = (r * 10 + d) % WORD
  }
  return neg ? (WORD - r) % WORD : r
}

/** The low word of an integer literal's two's complement, read from its text
 *  (decimal or hex, signed): -1 for none. No BigInt (the kernel runs this). */
export function lowWord(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? ((v % WORD) + WORD) % WORD : -1
  return typeof v === 'string' ? wordAt(v, 0) : v == null ? -1 : wordAt(String(v), 0)
}

/** The low word of a float literal that can carry an address: a NaN box's
 *  payload, or (`integral`) an integral value. -1 for any other. */
function floatWord(v, integral) {
  if (typeof v === 'number') return integral && Number.isInteger(v) && v >= 0 && v < WORD ? v : -1
  if (typeof v !== 'string') return -1
  const at = v.indexOf('nan:0x')
  if (at >= 0) return hexHalf(v, at + 6, false)
  if (!integral) return -1
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 && n < WORD ? n : -1
}

const COMPARE = new Set(), SHIFT = new Set(), TRUNC = new Set()
for (const t of ['i32', 'i64']) {
  for (const c of ['eqz', 'eq', 'ne', 'lt_s', 'lt_u', 'gt_s', 'gt_u', 'le_s', 'le_u', 'ge_s', 'ge_u']) COMPARE.add(t + '.' + c)
  for (const c of ['shl', 'shr_s', 'shr_u', 'rotl', 'rotr']) SHIFT.add(t + '.' + c)
  for (const c of ['trunc_f64_s', 'trunc_f64_u', 'trunc_sat_f64_s', 'trunc_sat_f64_u']) TRUNC.add(t + '.' + c)
}
for (const t of ['f32', 'f64']) for (const c of ['eq', 'ne', 'lt', 'gt', 'le', 'ge']) COMPARE.add(t + '.' + c)

/** Each 32-bit word a `v128.const` holds. */
function vectorWords(node, add) {
  const shape = node[1]
  if (shape === 'i32x4' || shape === 'i64x2') for (let i = 2; i < node.length; i++) add(lowWord(node[i]))
  else if (shape === 'f64x2') for (let i = 2; i < node.length; i++) add(floatWord(node[i], false))
  else if (shape === 'i16x8' || shape === 'i8x16') {
    const per = shape === 'i16x8' ? 2 : 4, unit = per === 2 ? 65536 : 256
    for (let i = 2; i + per <= node.length; i += per) {
      let w = 0
      for (let j = per - 1; j >= 0; j--) w = w * unit + (lowWord(node[i + j]) + WORD) % unit
      add(w)
    }
  }
}

/** Each word a node of code may address the data segment by, to `add`: an
 *  integer literal's low word, a NaN box's offset, a memory access's constant
 *  offset and its sum with a constant base. A literal only compared, or a
 *  shift's count, addresses nothing (a value equal to it comes from a reference
 *  of its own); a float does as a NaN box, or as the operand of a truncation O0
 *  leaves unfolded. `parent` is the node's parent's op, `at` its index there. */
export function constWords(node, parent, at, add) {
  const op = node[0]
  if (op === 'i32.const' || op === 'i64.const' || op === 'f64.const' || op === 'v128.const') {
    if (COMPARE.has(parent) || (at === 2 && SHIFT.has(parent))) return
    if (op === 'v128.const') vectorWords(node, add)
    else add(op === 'f64.const' ? floatWord(node[1], TRUNC.has(parent)) : lowWord(node[1]))
  } else if (typeof op === 'string' && (op.includes('.load') || op.includes('.store') || op.includes('atomic'))) {
    let off = -1, base = -1
    for (let i = 1; i < node.length; i++) {
      const c = node[i]
      if (typeof c === 'string' && c.startsWith('offset=')) off = wordAt(c, 7)
      else if (base < 0 && Array.isArray(c) && c[0] === 'i32.const') base = lowWord(c[1])
    }
    if (off >= 0) { add(off); if (base >= 0) add(base + off) }
  }
}

/** The address a pointer literal names: a heap box's offset (`f64.const nan:…`,
 *  `i64.const 0x7ff8…`; not an atom's id, a host reference's or a short
 *  string's packed units) or the literal offset `__mkptr` boxes. -1 for any
 *  other node. */
export function boxOffset(node) {
  const op = node[0]
  if (op === 'call' && node[1] === '$__mkptr')
    return Array.isArray(node[4]) && node[4][0] === 'i32.const' ? lowWord(node[4][1]) : -1
  if ((op !== 'f64.const' && op !== 'i64.const') || typeof node[1] !== 'string') return -1
  const t = node[1], from = op === 'f64.const' ? (t.startsWith('nan:0x') ? 6 : -1) : (t.startsWith('0x') ? 2 : -1)
  if (from < 0) return -1
  const hi = hexHalf(t, from, true)
  if (hi < 0) return -1
  const tag = (hi >>> 15) & 15
  if (((hi >>> 16) & 0xFFF8) !== LAYOUT.NAN_PREFIX || tag === PTR.ATOM || tag === PTR.EXTERNAL) return -1
  if (tag === PTR.STRING && (hi & LAYOUT.SSO_BIT)) return -1
  return hexHalf(t, from, false)
}
