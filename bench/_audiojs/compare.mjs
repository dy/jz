export const bitsEqual = (a, b) => {
  if (a.length !== b.length || a.BYTES_PER_ELEMENT !== b.BYTES_PER_ELEMENT) return false
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
  return true
}

/** Agreement of two sample arrays: 'bit-exact', or the signal-to-error ratio in dB. */
export function agreement(ref, got) {
  if (ref.length !== got.length) return `length ${ref.length} vs ${got.length}`
  if (bitsEqual(ref, got)) return 'bit-exact'
  let peak = 0, err = 0
  for (let i = 0; i < ref.length; i++) {
    const d = ref[i] - got[i]
    if (d !== d) return 'NaN'
    err += d * d
    if (Math.abs(ref[i]) > peak) peak = Math.abs(ref[i])
  }
  if (!err) return 'Infinity dB'
  // Round down so the displayed verdict cannot promote a result below the
  // acceptance boundary into a passing one.
  return `${Math.floor(20 * Math.log10(peak / Math.sqrt(err / ref.length)))} dB`
}

export const exactAgreement = (ref, got) => bitsEqual(ref, got) ? 'bit-exact' : `different bytes (${agreement(ref, got)})`

// Decoders require exact samples in every channel; a matching first channel
// must never hide a different later channel or channel count.
export const channelsAgree = (ref, got) => {
  if (ref.length !== got.length) return `channels ${ref.length} vs ${got.length}`
  for (let i = 0; i < ref.length; i++) {
    const note = agreement(ref[i], got[i])
    if (note !== 'bit-exact') return `channel ${i}: ${note}`
  }
  return 'bit-exact'
}
// Floating DSP kernels may differ only within the existing 100 dB rounding
// boundary. Codec bytes and scalar results use their exact comparison above.
export const agrees = note => note === 'bit-exact' || /^same(?: bytes)? \(/.test(note) || /^(?:Infinity|\d+(?:\.\d+)?) dB$/.test(note) && parseFloat(note) >= 100
