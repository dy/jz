#!/usr/bin/env node
// Host driver for biquad.wat — assembles wat → wasm via wabt, instantiates,
// and drives mkInput / mkCoeffs / processCascade / checksum from JS using
// the same loop shape as biquad.js. This is the "floor": pure wasm hot
// loop with zero JS→wasm compiler overhead.
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const here = (...p) => join(__dirname, ...p)
const buildDir = process.env.JZ_BENCH_BUILD_DIR || join(tmpdir(), 'jz-bench', 'biquad')
fs.mkdirSync(buildDir, { recursive: true })

const N_SAMPLES = 480000
const N_STAGES = 8
const N_RUNS = 21
const N_WARMUP = 5

// Memory layout (matches biquad.wat header).
const X_PTR      = 0x0000_0000
const COEFFS_PTR = 0x0040_0000
const STATE_PTR  = 0x0040_1000
const OUT_PTR    = 0x0040_2000

const wasmPath = join(buildDir, 'biquad-wat.wasm')
execSync(`wat2wasm ${JSON.stringify(here('biquad.wat'))} -o ${JSON.stringify(wasmPath)}`,
  { stdio: 'pipe' })
const bytes = fs.readFileSync(wasmPath)
const { instance } = await WebAssembly.instantiate(bytes, {})
const { mkInput, mkCoeffs, zero, processCascade, checksum, memory } = instance.exports

mkInput(X_PTR, N_SAMPLES)
mkCoeffs(COEFFS_PTR, N_STAGES)

for (let i = 0; i < N_WARMUP; i++) {
  zero(STATE_PTR, N_STAGES * 4)
  processCascade(X_PTR, COEFFS_PTR, STATE_PTR, N_STAGES, OUT_PTR, N_SAMPLES)
}

const samples = new Float64Array(N_RUNS)
for (let i = 0; i < N_RUNS; i++) {
  zero(STATE_PTR, N_STAGES * 4)
  const t0 = performance.now()
  processCascade(X_PTR, COEFFS_PTR, STATE_PTR, N_STAGES, OUT_PTR, N_SAMPLES)
  samples[i] = performance.now() - t0
}

const cs = checksum(OUT_PTR, N_SAMPLES) >>> 0
const sorted = [...samples].sort((a, b) => a - b)
const medianMs = sorted[(N_RUNS - 1) >> 1]
const medianUs = (medianMs * 1000) | 0
console.log(`median_us=${medianUs} checksum=${cs} samples=${N_SAMPLES} stages=${N_STAGES} runs=${N_RUNS}`)
