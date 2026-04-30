// biquad-flat.js — biquad.js with `export` stripped and main() called at
// top level. For runtimes that don't support ESM imports (porffor, qjs).
// Keep this file in sync with biquad.js — it's a sed-style copy, not a
// fork: only the `export let main = ...` declaration loses `export`, and
// a `main()` call is appended.

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

const checksum = (out) => {
  const u = new Uint32Array(out.buffer, out.byteOffset, out.length * 2)
  let h = 0x811c9dc5 | 0
  const stride = 4096
  for (let i = 0; i < u.length; i += stride) {
    h = Math.imul(h ^ u[i], 0x01000193)
  }
  return (h >>> 0)
}

const run = () => {
  const x = mkInput(N_SAMPLES)
  const coeffs = mkCoeffs(N_STAGES)
  const state = new Float64Array(N_STAGES * 4)
  const out = new Float64Array(N_SAMPLES)

  // Inline state reset (no closure) — porffor's closure support drops the
  // capture of `state` + `stateLen` here; jz already handles it but gets
  // pulled into __dyn_get_expr if .fill is used. Inlining keeps every target
  // on the same hot-path shape.
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

  const cs = checksum(out)
  const sorted = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) sorted[i] = samples[i]
  for (let i = 1; i < N_RUNS; i++) {
    const v = sorted[i]
    let j = i - 1
    while (j >= 0 && sorted[j] > v) { sorted[j + 1] = sorted[j]; j-- }
    sorted[j + 1] = v
  }
  const medianMs = sorted[(N_RUNS - 1) >> 1]
  const msamp = N_SAMPLES / (medianMs * 1000)
  return { medianMs, msamp, cs, samples: N_SAMPLES, stages: N_STAGES, runs: N_RUNS }
}

const main = () => {
  const r = run()
  const medianUs = (r.medianMs * 1000) | 0
  console.log(`median_us=${medianUs} checksum=${r.cs} samples=${r.samples} stages=${r.stages} runs=${r.runs}`)
}

main()
