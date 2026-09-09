// Internal string payloads are UTF-16LE. Lengths count code units; buffers
// count bytes. These routines preserve lone surrogates, unlike text decoders.
export function stringBytes(str) {
  const bytes = new Uint8Array(str.length * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < str.length; i++) view.setUint16(i * 2, str.charCodeAt(i), true)
  return bytes
}

export function stringHash(str) {
  let h = 0x811c9dc5 | 0
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193) | 0
  return (h <= 1 ? h + 2 : h) >>> 0
}
