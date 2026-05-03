// biquad-flat.js — biquad.js inlined for runtimes without ESM imports (porffor, qjs).
// Benchlib helpers are inlined here since ESM imports aren't available.

const N_SAMPLES = 480000
const N_STAGES = 8
const N_RUNS = 21
const N_WARMUP = 5

const mkInput = (n) => {
  const out = new Float64Array(n)
  let s = 0x1234abcd | 0
  for (let i = 0; i < n; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    out[i] = ((s >>> 0) / 4294967296) * 2 - 1
  }
  return out
}

const mkCoeffs = (n) => {
  const out = new Float64Array(n * 5)
  for (let i = 0; i < n; i++) {
    out[i * 5 + 0] = 0.10 + i * 0.001
    out[i * 5 + 1] = 0.20 - i * 0.0005
    out[i * 5 + 2] = 0.10
    out[i * 5 + 3] = -1.50 + i * 0.01
    out[i * 5 + 4] = 0.60 - i * 0.005
  }
  return out
}

const processCascade = (x, coeffs, state, nStages, out) => {
  const n = x.length
  for (let i = 0; i < n; i++) {
    let v = x[i]
    for (let s = 0; s < nStages; s++) {
      const c = s * 5
      const sb = s * 4
      const b0 = coeffs[c + 0]
      const b1 = coeffs[c + 1]
      const b2 = coeffs[c + 2]
      const a1 = coeffs[c + 3]
      const a2 = coeffs[c + 4]
      const x1 = state[sb + 0]
      const x2 = state[sb + 1]
      const y1 = state[sb + 2]
      const y2 = state[sb + 3]
      const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
      state[sb + 0] = v
      state[sb + 1] = x1
      state[sb + 2] = y
      state[sb + 3] = y1
      v = y
    }
    out[i] = v
  }
}

// Inlined from benchlib (stride 256 to match benchlib standard)
const checksumF64 = (out) => {
  const u = new Uint32Array(out.buffer, out.byteOffset, out.length * 2)
  let h = 0x811c9dc5 | 0
  const stride = 256
  for (let i = 0; i < u.length; i += stride) {
    h = Math.imul(h ^ (u[i] | 0), 0x01000193)
  }
  return h >>> 0
}

const medianUs = (samples) => {
  for (let i = 1; i < samples.length; i++) {
    const v = samples[i]
    let j = i - 1
    while (j >= 0 && samples[j] > v) { samples[j + 1] = samples[j]; j-- }
    samples[j + 1] = v
  }
  return (samples[(samples.length - 1) >> 1] * 1000) | 0
}

const printResult = (medianUs, checksum, samples, stages, runs) => {
  console.log(`median_us=${medianUs} checksum=${checksum} samples=${samples} stages=${stages} runs=${runs}`)
}

const run = () => {
  const x = mkInput(N_SAMPLES)
  const coeffs = mkCoeffs(N_STAGES)
  const state = new Float64Array(N_STAGES * 4)
  const out = new Float64Array(N_SAMPLES)

  const stateLen = N_STAGES * 4

  for (let i = 0; i < N_WARMUP; i++) {
    for (let j = 0; j < stateLen; j++) state[j] = 0
    processCascade(x, coeffs, state, N_STAGES, out)
  }

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    for (let j = 0; j < stateLen; j++) state[j] = 0
    const t0 = performance.now()
    processCascade(x, coeffs, state, N_STAGES, out)
    samples[i] = performance.now() - t0
  }

  printResult(medianUs(samples), checksumF64(out), N_SAMPLES, N_STAGES, N_RUNS)
}

const main = () => {
  run()
}

main()
