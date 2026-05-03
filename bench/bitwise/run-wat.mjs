#!/usr/bin/env node
// Host driver for bitwise.wat — assembles wat → wasm via wabt, instantiates,
// and drives init / kernel / checksum from JS using the same loop shape as
// bitwise.js.
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const here = (...p) => join(__dirname, ...p)
const buildDir = process.env.JZ_BENCH_BUILD_DIR || join(tmpdir(), 'jz-bench', 'bitwise')
fs.mkdirSync(buildDir, { recursive: true })

const N = 65536
const N_ROUNDS = 128
const N_RUNS = 21
const N_WARMUP = 5

const STATE_PTR = 0

const wasmPath = join(buildDir, 'bitwise-wat.wasm')
execSync(`wat2wasm ${JSON.stringify(here('bitwise.wat'))} -o ${JSON.stringify(wasmPath)}`,
  { stdio: 'pipe' })
const bytes = fs.readFileSync(wasmPath)
const { instance } = await WebAssembly.instantiate(bytes, {})
const { init, kernel, checksum, memory } = instance.exports

init(STATE_PTR, N)
for (let i = 0; i < N_WARMUP; i++) {
  kernel(STATE_PTR, N, N_ROUNDS)
}

const samples = new Float64Array(N_RUNS)
for (let i = 0; i < N_RUNS; i++) {
  init(STATE_PTR, N)
  const t0 = performance.now()
  kernel(STATE_PTR, N, N_ROUNDS)
  samples[i] = performance.now() - t0
}

const medianUs = (samples) => {
  const a = new Float64Array(samples)
  a.sort()
  const n = a.length
  return ((n % 2 === 1 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2) * 1000) | 0
}

const cs = checksum(STATE_PTR, N) >>> 0
console.log(`median_us=${medianUs(samples)} checksum=${cs} samples=${N * N_ROUNDS} stages=3 runs=${N_RUNS}`)
