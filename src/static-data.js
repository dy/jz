/** Static data and shared string pools contain bytes, never JS text. */
import { ctx } from './ctx.js'
import { LAYOUT } from '../layout.js'

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
