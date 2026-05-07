#!/usr/bin/env node
// Host driver for poly.wat — assembles wat → wasm via wabt, instantiates,
// and drives init / runKernel from JS using the same loop shape as poly.js.
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const here = (...p) => join(__dirname, ...p)
const buildDir = process.env.JZ_BENCH_BUILD_DIR || join(tmpdir(), 'jz-bench', 'poly')
fs.mkdirSync(buildDir, { recursive: true })

const N = 8192
const N_ITERS = 80
const N_RUNS = 21
const N_WARMUP = 5

const F64_PTR = 0x0000_0000
const I32_PTR = 0x0001_0000

const wasmPath = join(buildDir, 'poly-wat.wasm')
execSync(`wat2wasm ${JSON.stringify(here('poly.wat'))} -o ${JSON.stringify(wasmPath)}`,
  { stdio: 'pipe' })
const bytes = fs.readFileSync(wasmPath)
const { instance } = await WebAssembly.instantiate(bytes, {})
const { init, runKernel } = instance.exports

init(F64_PTR, I32_PTR, N)

let cs = 0
for (let i = 0; i < N_WARMUP; i++) cs = runKernel(F64_PTR, I32_PTR, N, N_ITERS) >>> 0

const samples = new Float64Array(N_RUNS)
for (let i = 0; i < N_RUNS; i++) {
  const t0 = performance.now()
  cs = runKernel(F64_PTR, I32_PTR, N, N_ITERS) >>> 0
  samples[i] = performance.now() - t0
}

const sorted = [...samples].sort((a, b) => a - b)
const medianUs = (sorted[(N_RUNS - 1) >> 1] * 1000) | 0
console.log(`median_us=${medianUs} checksum=${cs} samples=${N * N_ITERS * 2} stages=2 runs=${N_RUNS}`)
