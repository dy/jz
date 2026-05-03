export let medianUs = (samples) => {
  for (let i = 1; i < samples.length; i++) {
    const v = samples[i]
    let j = i - 1
    while (j >= 0 && samples[j] > v) { samples[j + 1] = samples[j]; j-- }
    samples[j + 1] = v
  }
  return (samples[(samples.length - 1) >> 1] * 1000) | 0
}

export let mix = (h, x) => Math.imul(h ^ (x | 0), 0x01000193)

export let checksumF64 = (out) => {
  const u = new Uint32Array(out.buffer, out.byteOffset, out.length * 2)
  let h = 0x811c9dc5 | 0
  const stride = 256
  for (let i = 0; i < u.length; i += stride) h = mix(h, u[i])
  return h >>> 0
}

export let checksumU32 = (out) => {
  let h = 0x811c9dc5 | 0
  const stride = 128
  for (let i = 0; i < out.length; i += stride) h = mix(h, out[i])
  return h >>> 0
}

export let printResult = (medianUs, checksum, samples, stages, runs) => {
  console.log(`median_us=${medianUs} checksum=${checksum} samples=${samples} stages=${stages} runs=${runs}`)
}
