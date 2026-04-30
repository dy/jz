// biquad.js — direct-form-1 biquad filter cascade on Float64Array.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly
// by the JS engines (V8, QuickJS). Stays inside the lowest common subset:
//   - const/let + arrow functions only (no class, no async, no regex)
//   - Float64Array + Uint32Array (typed arrays)
//   - Math.imul for portable 32-bit checksum
//   - No DataView, no BigInt (jawsm/porffor support varies)
//
// Algorithm: per sample, 8-stage cascade of direct-form-1 biquads.
//   y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]
// Each stage's output feeds the next. State + coeffs live in flat Float64Arrays
// (jz's TYPED narrowing + .map-receiver unbox land here).
//
// Reports: median ms across N_RUNS, throughput in Msamp/s, output checksum
// (FNV-1a over a sparse stride of the result so the optimizer can't elide it).

const N_SAMPLES = 480000  // 10 s @ 48 kHz mono
const N_STAGES = 8
const N_RUNS = 21
const N_WARMUP = 5

// XorShift32: deterministic per-target. Output is in [-1, 1).
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

// Stable lowpass-ish coeffs varied per stage so optimizer can't fold the cascade.
// Layout: [b0, b1, b2, a1, a2] × N_STAGES.
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

// Hot path. Scalar — vectorization left to the engine.
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

// FNV-1a over a strided u32 view of the f64 output. Sparse so the hash itself
// isn't a meaningful share of runtime; bit-exact across LE platforms.
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

  // Inline state reset (no closure). `state.fill(0)` would pull
  // __dyn_get_expr + call_indirect into the bench's hot setup path on jz, and
  // a closure over `state`/`stateLen` trips porffor. The state buffer is
  // tiny (N_STAGES * 4 = 32 doubles), so the explicit loop is free.
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
  // Hand-rolled insertion sort over the small samples buffer — keeps the bench
  // free of `.sort(cmp)` closure dispatch (each target's cmp-call quirks would
  // distort the per-run timings we already captured).
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

// `main` is invoked explicitly by the host harness — both for V8/QuickJS
// (driver imports + calls) and for jz-compiled WASM (host calls
// `instance.exports.main()` after `_setMemory`). Avoiding top-level execution
// keeps us out of the start-section quagmire (jz's WASI memory isn't bound
// until after instantiation, so console.log from start would crash).
//
// Output prints integer microseconds + raw checksum to dodge `.toFixed()` —
// jz routes Number.toFixed through `__dyn_get_expr` + call_indirect when the
// receiver type isn't statically resolved off an OBJECT slot, which trips at
// the only-1-table-slot edge in this program. Integer μs is enough precision
// (1 μs ≪ 1 ms median), and the orchestrator parses + reformats.
export let main = () => {
  const r = run()
  const medianUs = (r.medianMs * 1000) | 0
  console.log(`median_us=${medianUs} checksum=${r.cs} samples=${r.samples} stages=${r.stages} runs=${r.runs}`)
}
