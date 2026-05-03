#!/usr/bin/env node
// Host driver for mat4.wat — assembles wat → wasm via wabt, instantiates,
// and drives init / multiplyMany / checksum from JS using the same loop
// shape as mat4.js.
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const here = (...p) => join(__dirname, ...p)
const buildDir = process.env.JZ_BENCH_BUILD_DIR || join(tmpdir(), 'jz-bench', 'mat4')
fs.mkdirSync(buildDir, { recursive: true })

const N_ITERS = 200000
const N_RUNS = 21
const N_WARMUP = 5

const A_PTR = 0
const B_PTR = 128
const OUT_PTR = 256

const wasmPath = join(buildDir, 'mat4-wat.wasm')
execSync(`wat2wasm ${JSON.stringify(here('mat4.wat'))} -o ${JSON.stringify(wasmPath)}`,
  { stdio: 'pipe' })
const bytes = fs.readFileSync(wasmPath)
const { instance } = await WebAssembly.instantiate(bytes, {})
const { multiplyMany, checksum, memory } = instance.exports

const init = () => {
  const f64 = new Float64Array(memory.buffer)
  for (let i = 0; i < 16; i++) {
    f64[A_PTR / 8 + i] = (i + 1) * 0.125
    f64[B_PTR / 8 + i] = (16 - i) * 0.0625
  }
}

init()
for (let i = 0; i < N_WARMUP; i++) {
  init()
  multiplyMany(A_PTR, B_PTR, OUT_PTR, N_ITERS)
}

const samples = new Float64Array(N_RUNS)
for (let i = 0; i < N_RUNS; i++) {
  init()
  const t0 = performance.now()
  multiplyMany(A_PTR, B_PTR, OUT_PTR, N_ITERS)
  samples[i] = performance.now() - t0
}

const medianUs = (samples) => {
  const a = new Float64Array(samples)
  a.sort()
  const n = a.length
  return ((n % 2 === 1 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2) * 1000) | 0
}

const cs = checksum(OUT_PTR) >>> 0
console.log(`median_us=${medianUs(samples)} checksum=${cs} samples=${N_ITERS * 16} stages=4 runs=${N_RUNS}`)
