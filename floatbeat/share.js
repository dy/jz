const LIMIT = 1024 * 1024
const base64 = bytes => {
  let text = ''
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const unbase64 = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))

export async function encodeFormula(source) {
  const bytes = new TextEncoder().encode(source)
  if (bytes.length > LIMIT) throw new Error('Formula is too long to share')
  const plain = base64(bytes)
  if (typeof CompressionStream !== 'function') return plain
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))
  const compressed = 'z.' + base64(new Uint8Array(await new Response(stream).arrayBuffer()))
  return compressed.length < plain.length ? compressed : plain
}

export async function decodeFormula(encoded) {
  let bytes = unbase64(encoded.startsWith('z.') ? encoded.slice(2) : encoded)
  if (encoded.startsWith('z.')) {
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader()
    const chunks = []; let length = 0
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        length += value.length
        if (length > LIMIT) throw new Error('Shared formula is too long')
        chunks.push(value)
      }
    } finally { await reader.cancel() }
    bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  }
  if (bytes.length > LIMIT) throw new Error('Shared formula is too long')
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}
