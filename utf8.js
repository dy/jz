// Metadata and WASI text also run in AudioWorkletGlobalScope, which need not
// provide TextDecoder. Keep native decoding where available.
const decoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8', { ignoreBOM: true }) : null

export function decodeUtf8(input, keepBOM = true) {
  let text
  if (decoder) text = decoder.decode(input)
  else {
    const bytes = ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input)
    const chars = []
    for (let i = 0; i < bytes.length;) {
      const lead = bytes[i++]
      if (lead < 0x80) { chars.push(String.fromCharCode(lead)); continue }
      const count = lead >= 0xC2 && lead <= 0xDF ? 1
        : lead >= 0xE0 && lead <= 0xEF ? 2 : lead >= 0xF0 && lead <= 0xF4 ? 3 : 0
      if (!count) { chars.push('\uFFFD'); continue }
      let value = lead & (0x7F >> count), valid = true
      for (let n = 0; n < count; n++) {
        const byte = bytes[i]
        const low = n === 0 && lead === 0xE0 ? 0xA0 : n === 0 && lead === 0xF0 ? 0x90 : 0x80
        const high = n === 0 && lead === 0xED ? 0x9F : n === 0 && lead === 0xF4 ? 0x8F : 0xBF
        if (byte == null || byte < low || byte > high) { valid = false; break }
        value = (value << 6) | (byte & 0x3F); i++
      }
      chars.push(valid ? String.fromCodePoint(value) : '\uFFFD')
    }
    text = chars.join('')
  }
  return !keepBOM && text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
}
