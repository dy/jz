/**
 * Static data segment accumulator — parts-array representation.
 *
 * The segment used to live as one growing string (`ctx.runtime.data += chunk`).
 * A member-target `+=` is a shape the self-compile's selfAccum analysis cannot
 * claim (aliasing of a ctx field is unprovable), so in the kernel every append
 * fresh-copied the ENTIRE accumulated segment — O(segment) per append,
 * triangular in total. Measured as 100.00% of the jz×jz goal-gate wall
 * (.work/research.md §EXHAUSTIVE ATTRIBUTION: 64,243 fresh concats /
 * 3,128,053,048 bytes inside one emitFunc call). Native V8 hid the same cost
 * behind rope strings.
 *
 * Representation: `ctx.runtime.dataParts` (chunk strings, joined once at
 * serialization) + `ctx.runtime.dataLen` (total length, maintained on every
 * push — all offset arithmetic reads this instead of `.length`). Amortized
 * O(bytes) end to end, in the kernel and natively alike.
 *
 * The shared-memory string pool (`strPool`) gets the same treatment.
 */

import { ctx } from './ctx.js'
import { LAYOUT } from '../layout.js'

const PAD = '\0\0\0\0\0\0\0'

/** Pad the segment to an `align`-byte boundary (align ≤ 8). */
export const dataAlign = (align) => {
  const r = ctx.runtime
  const pad = (align - (r.dataLen % align)) % align
  if (pad) { r.dataParts.push(PAD.slice(0, pad)); r.dataLen += pad }
}

/** Append one chunk; returns nothing (read `dataLen()` for offsets first). */
export const dataPush = (chunk) => {
  const r = ctx.runtime
  r.dataParts.push(chunk)
  r.dataLen += chunk.length
}

/** Current segment length — the offset the next `dataPush` would land at. */
export const dataLen = () => ctx.runtime.dataLen

/** Join to a single string (collapsing parts so repeat calls stay cheap). */
export const dataString = () => {
  const r = ctx.runtime
  if (r.dataParts.length > 1) r.dataParts = [r.dataParts.join('')]
  return r.dataParts.length ? r.dataParts[0] : ''
}

/** Replace the whole segment (assemble-time surgery: strip/reorder spans). */
export const dataReset = (s) => {
  const r = ctx.runtime
  r.dataParts = s ? [s] : []
  r.dataLen = s ? s.length : 0
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
  let chunk = ''
  for (let i = 0; i < u8.length; i++) chunk += String.fromCharCode(u8[i])
  dataPush(chunk)
  if (!ctx.runtime.staticPtrSlots) ctx.runtime.staticPtrSlots = []
  for (let i = 0; i < slots.length; i++) {
    if ((parseInt(slots[i].slice(2, 6), 16) & 0xFFF8) === LAYOUT.NAN_PREFIX) {
      ctx.runtime.staticPtrSlots.push(off + i * 8)
    }
  }
  return off
}

/** Shared-memory string pool: append one chunk, return its start offset. */
export const strPoolPush = (chunk) => {
  const r = ctx.runtime
  const off = r.strPoolLen
  r.strPoolParts.push(chunk)
  r.strPoolLen += chunk.length
  return off
}

export const strPoolLen = () => ctx.runtime.strPoolLen

export const strPoolString = () => {
  const r = ctx.runtime
  if (r.strPoolParts.length > 1) r.strPoolParts = [r.strPoolParts.join('')]
  return r.strPoolParts.length ? r.strPoolParts[0] : ''
}
